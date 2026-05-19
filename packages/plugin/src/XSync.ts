import type { FileEntry, ServerMsg, BackgroundSyncReq } from "@ionsync/protocol";
import type { TAbstractFile } from "obsidian";
import { WsManager, type UpdateInfo } from "./WsManager.js";
import { Storage } from "./Storage.js";
import { XNotify, NotifyType, STATUS_WARN } from "./XNotify.js";
import { XTimeouts } from "./XTimeouts.js";
import { ExclusionFilter } from "./ExclusionFilter.js";
import Utils from "./Utils.js";
import type { IonSyncPlugin } from "./main.js";
import { diff_match_patch } from "diff-match-patch";
import { deriveKey, encryptToBase64, decryptFromBase64, isEncryptedBase64 } from "./Crypto.js";

const CHUNK_SIZE = 2_000;

interface DeleteQueueEntry {
  metadata: Partial<FileEntry>;
  timestamp: number;
}

type VaultAction = "create" | "modify" | "delete" | "rename";

export class XSync {
  isSyncing = false;
  ws: WsManager;
  storage: Storage;
  xNotify: XNotify;

  private xTimeouts = new XTimeouts();
  private exclusionFilter: ExclusionFilter | null = null;
  private eventRefs: Record<string, any> = {};

  private deleteQueue: Record<string, DeleteQueueEntry> = {};
  private isProcessingDeleteQueue = false;

  private unsentSessionEvents: Record<string, { action: VaultAction; file: TAbstractFile }> = {};
  private activityLog: string[] = [];
  private readonly MAX_ACTIVITY = 200;

  private syncUpCount = 0;
  private syncDownCount = 0;
  private syncApplyCount = 0;

  private configCheckInterval: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  private inited = false;
  private isEnabled = false;

  private responseListeners: Array<(msg: ServerMsg) => boolean> = [];
  private messageQueue: ServerMsg[] = [];
  private isProcessingQueue = false;

  // Paths we are actively writing via _applyServerFile.  When the vault fires
  // a create/modify event for one of these paths we suppress it — otherwise the
  // plugin would re-upload the file it just received, which can race with edits
  // on other vaults and produce spurious "Conflicted Copy" files there.
  private _applyingPaths = new Set<string>();

  // ── E2EE key cache ────────────────────────────────────────────────────────
  // PBKDF2 derivation is expensive (~100–200 ms).  Cache the derived key and
  // only re-derive when the password changes.
  private _e2eeKey: CryptoKey | null = null;
  private _e2eeKeyPassword = "";

  private async _getEncryptionKey(): Promise<CryptoKey | null> {
    const { encryptionEnabled, encryptionPassword } = this.plugin.settings;
    if (!encryptionEnabled || !encryptionPassword) {
      this._e2eeKey = null;
      this._e2eeKeyPassword = "";
      return null;
    }
    if (this._e2eeKey && this._e2eeKeyPassword === encryptionPassword) {
      return this._e2eeKey;
    }
    this._e2eeKey = await deriveKey(encryptionPassword);
    this._e2eeKeyPassword = encryptionPassword;
    return this._e2eeKey;
  }


  constructor(public plugin: IonSyncPlugin) {
    this.ws = new WsManager(plugin.settings);
    this.storage = new Storage(plugin.app, plugin.settings, plugin.manifest.dir ?? '');
    this.xNotify = new XNotify(this);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async enabled(value: boolean): Promise<void> {
    if (this.isEnabled === value) return;
    this.isEnabled = value;
    if (value) await this.load();
    else this.unload();
  }

  async load(): Promise<void> {
    if (!this.isEnabled || this.inited) return;
    this.inited = true;

    this.ws.isEnabled = this.plugin.settings.syncEnabled;
    this.exclusionFilter = new ExclusionFilter(this.plugin.settings, this.plugin.app.vault.configDir);

    await this.storage.init();
    this.deleteQueue = await this.storage.loadDeleteQueue();

    this._registerVaultEvent("create");
    this._registerVaultEvent("modify");
    this._registerVaultEvent("delete");
    this._registerVaultEvent("rename");

    // PHASE 3: Background Sync Trigger
    this.eventRefs["visibility-change"] = () => {
      if (document.visibilityState === "hidden") {
        void this._performBackgroundSync();
      }
    };
    document.addEventListener("visibilitychange", this.eventRefs["visibility-change"]);

    const onFocus = Utils.debounce((() => { void this._onFocusChanged(); }) as () => unknown, 500) as () => void;
    this.eventRefs["active-leaf-change"] = this.plugin.app.workspace.on("active-leaf-change", onFocus);
    this.eventRefs["layout-change"] = this.plugin.app.workspace.on("layout-change", onFocus);

    this.configCheckInterval = window.setInterval(() => { void this._checkConfigFiles(); }, 5_000);

    this.ws.on((event) => {
      switch (event.type) {
        case "connected":      void this._onConnected(); break;
        case "disconnected":   this._onDisconnected(); break;
        case "message":        void this._queueMessage(event.msg); break;
        case "update_available": void this._onUpdateAvailable(event.update); break;
        case "incompatible":   this.xNotify.showNotification("#ff9800", "Incompatible plugin version"); break;
      }
    });

    this.ws.connect();
  }

  unload(): void {
    this.storage.abortTree();
    this.storage.tree = {};
    this.xTimeouts.clear();
    if (this.configCheckInterval !== null) {
      window.clearInterval(this.configCheckInterval);
      this.configCheckInterval = null;
    }

    if (this.eventRefs["visibility-change"]) {
      document.removeEventListener("visibilitychange", this.eventRefs["visibility-change"]);
    }

    if (!this.inited) return;
    this.inited = false;

    for (const type of ["create", "modify", "delete", "rename"]) {
      const ref = this.eventRefs[type];
      if (ref) this.plugin.app.vault.offref(ref);
      delete this.eventRefs[type];
    }
    const alc = this.eventRefs["active-leaf-change"];
    if (alc) this.plugin.app.workspace.offref(alc);
    const lc = this.eventRefs["layout-change"];
    if (lc) this.plugin.app.workspace.offref(lc);

    this.ws.disconnect();
    this.isSyncing = false;
  }

  destroy(): void {
    this.unload();
    this.xNotify.cleanup();
    this.ws.destroy();
    this.messageQueue = [];
  }

  // ── Background Sync (Phase 3) ───────────────────────────────────────────

  private async _performBackgroundSync(): Promise<void> {
    const pendingPaths = Object.keys(this.unsentSessionEvents);
    if (pendingPaths.length === 0) return;

    const payload: BackgroundSyncReq["files"] = [];
    for (const path of pendingPaths) {
      const ev = this.unsentSessionEvents[path];
      if (!ev) continue;

      const stat = await this.plugin.app.vault.adapter.stat(ev.file.path);
      if (!stat) continue;

      const isBinary = Utils.isBinary(ev.file.path);
      let content = "";
      let sha1: string | null = "";

      if (isBinary) {
        const buf = await this.storage.readBinary(ev.file.path);
        if (buf) {
          content = Utils.toBase64(new Uint8Array(buf));
          sha1 = await Utils.getSHABinary(buf);
        }
      } else {
        const txt = await this.storage.read(ev.file.path);
        if (txt !== null) {
          content = Utils.toBase64(txt);
          sha1 = await Utils.getSHA(txt);
        }
      }

      payload.push({
        file: { path: ev.file.path, sha1: sha1 ?? "", mtime: stat.mtime, action: "active", fileType: "file" },
        content
      });
    }

    const { host, port, tls, deviceId } = this.plugin.settings;
    const protocol = tls ? "https" : "http";
    const url = `${protocol}://${host}:${port}/api/sync/background`;

    const blob = new Blob([JSON.stringify({ deviceId: deviceId, files: payload })], { type: 'application/json' });

    const success = navigator.sendBeacon(url, blob);
    if (success) {
      this.unsentSessionEvents = {};
      this.xNotify.updatePendingCount(0);
    }
  }

  // ── Incoming Messages ─────────────────────────────────────────────────────

  private async _queueMessage(msg: ServerMsg): Promise<void> {
    this.messageQueue.push(msg);
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    while (this.messageQueue.length > 0) {
      const next = this.messageQueue.shift();
      if (next) {
        try { await this._handleServerMessage(next); }
        catch (e) { console.error("[XSync] message processing error:", e); }
      }
    }
    this.isProcessingQueue = false;
  }

  private async _handleServerMessage(msg: ServerMsg): Promise<void> {
    this.responseListeners = this.responseListeners.filter((cb) => !cb(msg));

    switch (msg.type) {
      case "file_event_result":
        if (msg.result === "client_newer") await this._uploadFile(msg.path);
        break;
      case "file_push":
        await this._applyServerFile(msg.file, msg.content);
        break;
      case "sync_done":
        await this._onSyncDone();
        break;
    }
  }

  private async _applyServerFile(file: FileEntry, content: string): Promise<void> {
    // Emergency guard: drop developer folders
    if (file.path.includes("node_modules/") || file.path.includes(".git/")) return;
    if (this.exclusionFilter?.isExcluded(file.path)) return;

    // When true, re-upload the file encrypted after writing so the server's
    // stored copy is upgraded from plaintext to ciphertext.
    let shouldReencrypt = false;

    // ── E2EE decrypt ──────────────────────────────────────────────────────
    // If the incoming content carries our encryption magic, decrypt it before
    // passing it to the write path (which expects a plain base64 payload).
    if (file.action !== "deleted" && content && isEncryptedBase64(content)) {
      const key = await this._getEncryptionKey();
      if (!key) {
        console.warn(`[IonSync] E2EE: received encrypted file but no decryption key is configured — skipping ${file.path}`);
        this.xNotify.showNotification(STATUS_WARN, "Encrypted file received — enable E2EE in settings to decrypt");
        return;
      }
      try {
        const plainBytes = await decryptFromBase64(key, content);
        // Re-encode as plain base64 so the existing write path handles it normally.
        content = Utils.toBase64(new Uint8Array(plainBytes));
      } catch (e) {
        console.error(`[IonSync] E2EE: decryption failed for ${file.path} — wrong password or corrupted data:`, e);
        this.xNotify.showNotification(STATUS_WARN, `E2EE decrypt failed: ${file.path}`);
        return;
      }
    } else if (file.action !== "deleted" && content) {
      // Reverse guard: this device has E2EE enabled but the incoming content is
      // plaintext (no magic header). This typically means the server is pushing
      // an old pre-E2EE version (e.g. a deleted file stored before encryption was
      // enabled). Rather than skipping, we accept the plaintext, write it to the
      // vault, then immediately re-upload it encrypted so the server's stored copy
      // is upgraded and future pushes will always be ciphertext.
      const key = await this._getEncryptionKey();
      if (key) {
        console.warn(`[IonSync] E2EE: received unencrypted file — writing and scheduling re-encrypt: ${file.path}`);
        shouldReencrypt = true;
        // Fall through: content is already plain base64, the write path handles it normally.
      }
    }

    try {
      const localStat = await this.plugin.app.vault.adapter.stat(file.path);

      const localMeta = this.storage.readMetadata(file.path);

      if (file.action !== "deleted" && file.fileType === "file" && localStat && localStat.type === "file") {
        if (!localMeta || localStat.mtime > localMeta.mtime) {
          const isBinary = Utils.isBinary(file.path);
          let isSame = false;

          if (isBinary) {
            const buf = await this.storage.readBinary(file.path);
            if (buf && (await Utils.getSHABinary(buf)) === file.sha1) isSame = true;
          } else {
            const txt = await this.storage.read(file.path);
            if (txt !== null && (await Utils.getSHA(txt)) === file.sha1) isSame = true;
          }

          if (!isSame) {
            this.plugin.log(`[Conflict] ${file.path} modified offline. Backing up.`);
            await this._createConflictedCopy(file.path);
          }
        }
      }

      if (file.action === "deleted") {
        // Never recursively trash an entire folder — trashFile() on a TFolder
        // removes all of its contents in one call, causing mass data loss if a
        // folder entry is accidentally or spuriously marked deleted on the server.
        // Individual file deletions propagate correctly; folder-level deletes are
        // simply ignored and the folder will disappear naturally once all files
        // inside it are deleted.
        if (file.fileType === "folder") return;
        await this.storage.delete(file.path, file);
        this.addActivity("delete", file.path);
      } else if (file.fileType === "folder") {
        if (localStat && localStat.type === "file") return;
        // Pre-register every path component so that:
        //  (a) vault "create" events from new folder creation are suppressed, and
        //  (b) vault "delete" events from ENOTDIR collision handling (trashFile)
        //      in FSAdapter.makeFolder are suppressed — otherwise the trashFile
        //      call would fire a vault "delete" event that gets queued and sent to
        //      the server as action:"deleted", incorrectly marking the file deleted.
        const parts = file.path.split("/");
        for (let i = 1; i <= parts.length; i++) {
          this._applyingPaths.add(parts.slice(0, i).join("/"));
        }
        await this.storage.makeFolder(file.path, file);
      } else {
        if (localStat && localStat.type === "folder") return;

        // Show applying-file progress in the status bar.
        this.syncApplyCount++;
        // Throttle to every 5th file to avoid excessive repaints on large syncs.
        if (this.syncApplyCount === 1 || this.syncApplyCount % 5 === 0) {
          const name = file.path.split("/").pop() ?? file.path;
          this.xNotify.updateSyncProgress(`↓ ${name}`);
        }

        // Retry once on write failure (Android FILE_NOTCREATED can be transient
        // if the mkdir races with the write on a slow filesystem).
        let writeErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            console.log(`[IonSync] Applying file ${file.path}, attempt ${attempt + 1}`);
            // Register before writing so the vault event is caught by the guard
            // in _processLocalEvent and suppressed (prevents spurious re-uploads).
            this._applyingPaths.add(file.path);
            if (Utils.isBinary(file.path)) await this.storage.writeBinary(file.path, content, file);
            else await this.storage.write(file.path, content, file);
            writeErr = null;
            break;
          } catch (e) {
            console.warn(`[IonSync] Failed write for ${file.path} on attempt ${attempt + 1}:`, e);
            // Write failed — no vault event will fire, so clean up the guard entry.
            this._applyingPaths.delete(file.path);
            writeErr = e;
            // On first failure ensure parent dirs exist then retry.
            if (attempt === 0) {
              const parent = file.path.split("/").slice(0, -1).join("/");
              if (parent) await this.storage.makeFolder(parent, { ...file, fileType: "folder", action: "active" });
              await new Promise(r => setTimeout(r, 80));
            }
          }
        }
        if (writeErr) {
          this._applyingPaths.delete(file.path); // final cleanup if both attempts failed
          throw writeErr;
        }

        this.addActivity("down", file.path);
        this.syncDownCount++;

        // If we accepted an unencrypted server push, re-upload it encrypted
        // after a short delay so any in-progress sync messages have settled.
        // This upgrades the server's stored copy to ciphertext and prevents
        // future "unencrypted file received" alerts for this file.
        if (shouldReencrypt) {
          setTimeout(() => this.pushFile(file.path), 1500);
        }
      }
    } catch (e) {
      console.error(`[IonSync] Error applying server file (${file.path}):`, e);
    }
  }

  private async _createConflictedCopy(originalPath: string): Promise<void> {
    const date = new Date();
    const ts = date.toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const lastDot = originalPath.lastIndexOf(".");
    const pathNoExt = lastDot > 0 ? originalPath.slice(0, lastDot) : originalPath;
    const ext = lastDot > 0 ? originalPath.slice(lastDot) : "";
    const newPath = `${pathNoExt} (Conflicted Copy ${ts})${ext}`;

    if (Utils.isBinary(originalPath)) {
      const buf = await this.storage.readBinary(originalPath);
      if (buf) await this.plugin.app.vault.adapter.writeBinary(newPath, buf);
    } else {
      const txt = await this.storage.read(originalPath);
      if (txt !== null) await this.plugin.app.vault.adapter.write(newPath, txt);
    }
    this.xNotify.showNotification("#ff9800", `Conflict saved: ${newPath}`);
  }

  // ── Sync Engine ───────────────────────────────────────────────────────────

  async sync(): Promise<void> {
    if (!this.ws.isConnected || this.isSyncing) return;
    this.isSyncing = true;
    this.syncUpCount = 0;
    this.syncDownCount = 0;
    this.syncApplyCount = 0;

    // Brand-new device: no prior metadata means we have never completed a sync.
    // Withhold config/settings uploads until sync_done so the server's
    // authoritative versions come down first, preventing a fresh device from
    // overwriting other devices' settings with locally-generated defaults.
    this._isFirstSync = !this.storage.hasAnyMetadata();
    if (this._isFirstSync) {
      this.plugin.log("[IonSync] First sync detected — config file uploads deferred until sync_done");
    }

    try {
      for (const [, ev] of Object.entries(this.unsentSessionEvents)) {
        await this._processLocalEvent(ev.action, ev.file, false);
      }
      this.unsentSessionEvents = {};

      await this.acquireWakeLock();
      this.xNotify.notifyStatus(NotifyType.SYNCING);
      await this.storage.computeTree();

      const files: FileEntry[] = [];
      for (const [path, entry] of Object.entries(this.storage.tree)) {
        if (!this.exclusionFilter?.isExcluded(path)) files.push(entry);
      }

      if (files.length === 0) {
        this.ws.send({ type: "sync", files: [], last: true });
      } else {
        const chunkCount = Math.ceil(files.length / CHUNK_SIZE);
        for (let i = 0; i < files.length; i += CHUNK_SIZE) {
          await new Promise<void>((r) => setTimeout(r, 0));
          const chunkIndex = Math.floor(i / CHUNK_SIZE);
          const isLast = chunkIndex === chunkCount - 1;
          this.ws.send({ type: "sync", files: files.slice(i, i + CHUNK_SIZE), last: isLast });
        }
      }
    } catch (e) {
      this.isSyncing = false;
      this.releaseWakeLock();
      this.xNotify.notifyStatus(this.ws.isConnected ? NotifyType.CONNECTED : NotifyType.NOT_CONNECTED);
    }
  }

  private async _onSyncDone(): Promise<void> {
    this.isSyncing = false;
    this._isFirstSync = false;  // device is now fully synced
    // Clear any stale _applyingPaths entries.  Normally each entry is consumed
    // as its vault event fires, but folder paths added during makeFolder calls
    // may never receive a matching event (e.g. folder already existed).
    this._applyingPaths.clear();
    this.releaseWakeLock();
    this.xNotify.setSyncSummary(this.syncUpCount, this.syncDownCount);
    this.syncUpCount = 0;
    this.syncDownCount = 0;
    this.syncApplyCount = 0;
    this.storage.tree = {};
    await this.storage.flushMetadata();
  }

  private async _uploadFile(path: string): Promise<void> {
    if (!this.ws.isConnected) return;

    // On a brand-new device (first ever sync), don't upload config/settings
    // files — let the server push its authoritative versions down instead.
    // This prevents freshly-created Obsidian defaults from overwriting the
    // settings that every other device is already using.
    if (this._isFirstSync) {
      const configDir = this.plugin.app.vault.configDir;
      if (path.startsWith(configDir + "/") || path.startsWith(".obsidian/")) {
        this.plugin.log(`[IonSync] First sync — deferring config upload: ${path}`);
        return;
      }
    }

    const hardcodedBinaryCheck = /\.(jpeg|jpg|png|gif|bmp|webp|ico|svg|pdf|mp3|mp4|wav|mov|zip|rar|7z)$/i.test(path);
    const isBinary = Utils.isBinary(path) || hardcodedBinaryCheck;

    const stored = this.storage.readMetadata(path);
    const entry: FileEntry | null = (this.storage.tree[path] ?? stored) ?? null;
    if (!entry) return;

    let content = "";
    let mode: "apply" | "patch" = "apply";
    let liveSha1 = entry.sha1;

    const e2eeKey = await this._getEncryptionKey();

    if (entry.action === "active" && entry.fileType === "file") {
      if (isBinary) {
        const buf = await this.storage.readBinary(path);
        if (buf) {
          liveSha1 = (await Utils.getSHABinary(buf)) ?? "";
          content = e2eeKey
            ? await encryptToBase64(e2eeKey, buf)
            : Utils.toBase64(new Uint8Array(buf));
        }
      } else {
        const currentText = await this.storage.read(path);
        if (currentText !== null) {
          liveSha1 = (await Utils.getSHA(currentText)) ?? "";

          if (e2eeKey) {
            // E2EE: always send full ciphertext — patches are meaningless on ciphertext
            content = await encryptToBase64(e2eeKey, new TextEncoder().encode(currentText));
          } else {
            // Delta sync: send a patch when it's smaller than the full file
            const shadowText = await this.storage.readShadow(path);
            if (shadowText !== null && shadowText !== currentText) {
              const dmp = new diff_match_patch();
              const diffs = dmp.diff_main(shadowText, currentText);
              dmp.diff_cleanupSemantic(diffs);
              const patches = dmp.patch_make(shadowText, currentText, diffs);
              const patchText = dmp.patch_toText(patches);
              if (patchText.length < currentText.length) {
                mode = "patch";
                content = patchText;
                this.plugin.log(`[Delta] Sending patch for ${path}`);
              } else {
                content = Utils.toBase64(currentText);
              }
            } else {
              content = Utils.toBase64(currentText);
            }
            await this.storage.writeShadow(path, currentText);
          }
        }
      }
    }

    entry.sha1 = liveSha1;
    this.ws.send({ type: "file_data", mode: mode as any, file: entry, content });
    this.addActivity("up", path);
    this.syncUpCount++;
    await this.storage.writeMetadata(entry);
  }

  // ── Vault Events ─────────────────────────────────────────────────────────

  private _registerVaultEvent(type: VaultAction): void {
    this.eventRefs[type] = this.plugin.app.vault.on(type as any, async (file: TAbstractFile, ...args: unknown[]) => {
      if (!this.isEnabled) return;
      try { await this._processLocalEvent(type, file, false, args); }
      catch (e) { console.error(`[XSync] vault event error (${type}):`, e); }
    });
  }

  async _processLocalEvent(action: VaultAction, file: TAbstractFile, forceChanged = false, args: unknown[] = []): Promise<void> {
    // ✅ Emergency Guard: Do not process local edits in developer folders
    if (file.path.includes("node_modules/") || file.path.includes(".git/")) {
      return;
    }

    if (this.exclusionFilter?.isExcluded(file.path)) return;

    // Suppress the vault create/modify event that fires immediately after
    // _applyServerFile writes a file.  Without this guard the plugin would
    // re-upload the just-received file (often with the OS's current mtime
    // instead of the server's mtime), causing the server to broadcast a
    // slightly-different entry back to other connected vaults.  On those vaults
    // the incoming mtime can trigger the offline-edit conflict detector, which
    // then creates spurious "(Conflicted Copy)" files.
    // Suppress vault events that fire as a side-effect of _applyServerFile:
    //  - create/modify: consumed immediately (one-shot) so the guard auto-clears.
    //  - delete: NOT consumed — keep the entry so a subsequent create event on
    //    the same path (folder recreation after ENOTDIR collision) is also suppressed.
    if (this._applyingPaths.has(file.path)) {
      if (action === "create" || action === "modify") this._applyingPaths.delete(file.path);
      return;
    }

    if (action === "rename") {
      const oldPath = args[0] as string;
      const oldMeta = this.storage.readMetadata(oldPath);
      this.deleteQueue[oldPath] = {
        metadata: { action: "deleted", sha1: oldMeta?.sha1 ?? "", mtime: Date.now(), fileType: "file" },
        timestamp: Date.now(),
      };
      await this.storage.saveDeleteQueue(this.deleteQueue);
      if (this.ws.isConnected) await this._processDeleteQueue();
      await this._processLocalEvent("create", file, true);
      return;
    }

    if (action === "delete") {
      const meta = this.storage.readMetadata(file.path);
      this.deleteQueue[file.path] = {
        metadata: { action: "deleted", sha1: meta?.sha1 ?? "", mtime: Date.now(), fileType: "file" },
        timestamp: Date.now(),
      };
      await this.storage.saveDeleteQueue(this.deleteQueue);
      if (this.ws.isConnected) await this._processDeleteQueue();
      return;
    }

    if (!this.plugin.settings.autoSync || !this.ws.isConnected) {
      this.unsentSessionEvents[file.path] = { action, file };
      this.xNotify.updatePendingCount(Object.keys(this.unsentSessionEvents).length);
      return;
    }

    let delay = Math.max(this.plugin.settings.delayedSync ?? 2, 2);
    if (file.path.startsWith(this.plugin.app.vault.configDir + "/")) delay = 5;

    this.xTimeouts.set(file.path, delay * 1_000, async () => {
      await this._sendFileEvent(file, forceChanged);
    });
  }

  private async _sendFileEvent(file: TAbstractFile, forceChanged: boolean): Promise<void> {
    if (!this.ws.isConnected) return;
    const stat = await this.plugin.app.vault.adapter.stat(file.path);
    if (!stat) return;

    const stored = this.storage.readMetadata(file.path);
    if (!forceChanged && stored && stored.mtime === stat.mtime && stored.sha1) return;

    const isBinary = Utils.isBinary(file.path);
    let sha1: string | null = "";
    let content = "";
    let mode: "apply" | "patch" = "apply";

    const e2eeKey = await this._getEncryptionKey();

    if (isBinary) {
      const buf = await this.storage.readBinary(file.path);
      if (buf) {
        sha1 = await Utils.getSHABinary(buf);
        content = e2eeKey
          ? await encryptToBase64(e2eeKey, buf)
          : Utils.toBase64(new Uint8Array(buf));
      }
    } else {
      const currentText = await this.storage.read(file.path);
      if (currentText !== null) {
        sha1 = await Utils.getSHA(currentText);

        if (e2eeKey) {
          // E2EE: full ciphertext only — no delta patching on encrypted data
          content = await encryptToBase64(e2eeKey, new TextEncoder().encode(currentText));
        } else {
          const shadowText = await this.storage.readShadow(file.path);
          if (shadowText !== null && shadowText !== currentText) {
            const dmp = new diff_match_patch();
            const diffs = dmp.diff_main(shadowText, currentText);
            dmp.diff_cleanupSemantic(diffs);
            const patches = dmp.patch_make(shadowText, currentText, diffs);
            const patchText = dmp.patch_toText(patches);
            if (patchText.length < currentText.length) {
              mode = "patch";
              content = patchText;
              this.plugin.log(`[Delta] Sending patch for ${file.path}`);
            } else {
              content = Utils.toBase64(currentText);
            }
          } else {
            content = Utils.toBase64(currentText);
          }
          await this.storage.writeShadow(file.path, currentText);
        }
      }
    }

    const entry: FileEntry = { path: file.path, sha1: sha1 ?? "", mtime: stat.mtime, action: "active", fileType: "file" };
    this.ws.send({ type: "file_data", mode: mode as any, file: entry, content });
    await this.storage.writeMetadata(entry);
    this.addActivity("up", file.path);
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  private async _onConnected(): Promise<void> {
    this.xNotify.notifyStatus(NotifyType.CONNECTED);
    if (Object.keys(this.deleteQueue).length > 0) await this._processDeleteQueue();

    if (this.plugin.settings.autoSync) {
      // onLayoutReady fires immediately when the layout is already ready (which it
      // always is on a reconnect), but it also registers a *persistent* listener on
      // the workspace event that leaks across reconnects.  Check the flag directly
      // so we only queue sync() once without accumulating stale listeners.
      if (this.plugin.app.workspace.layoutReady) {
        void this.sync();
      } else {
        this.plugin.app.workspace.onLayoutReady(() => { void this.sync(); });
      }
    }
  }

  private _onDisconnected(): void {
    this.xNotify.notifyStatus(NotifyType.CONNECTION_LOST);
    this.isSyncing = false;
    this.releaseWakeLock();
  }

  private async _onUpdateAvailable(update: UpdateInfo): Promise<void> {
    await this.storage.updatePlugin(update.files);
    this.xNotify.showNotification("#ffaa00", "Plugin updated — reloading…");
    await (this.plugin.app as any).plugins.disablePlugin("ion-sync");
    await (this.plugin.app as any).plugins.enablePlugin("ion-sync");
  }

  private async _processDeleteQueue(): Promise<void> {
    if (!this.ws.isConnected || this.isProcessingDeleteQueue) return;
    const paths = Object.keys(this.deleteQueue);
    if (paths.length === 0) return;
    this.isProcessingDeleteQueue = true;
    try {
      for (const path of paths) {
        const entry = this.deleteQueue[path]!;
        const file: FileEntry = { path, sha1: entry.metadata.sha1 ?? "", mtime: entry.metadata.mtime ?? Date.now(), action: "deleted", fileType: "file" };
        this.ws.send({ type: "file_data", mode: "apply", file, content: "" });
        await this.storage.writeMetadata(file);
        delete this.deleteQueue[path];
      }
      await this.storage.saveDeleteQueue(this.deleteQueue);
    } finally {
      this.isProcessingDeleteQueue = false;
    }
  }


  private async _onFocusChanged(): Promise<void> {
    this.xTimeouts.executeAll();
    await this._checkConfigFiles();
  }

  private async _checkConfigFiles(): Promise<void> {
    if (!this.ws.isConnected || !this.plugin.settings.autoSync || this.isSyncing) return;
    const configDir = this.plugin.app.vault.configDir;
    const targets = [`${configDir}/app.json`, `${configDir}/appearance.json`, `${configDir}/hotkeys.json`, `${configDir}/community-plugins.json`].filter(p => !this.exclusionFilter?.isExcluded(p));

    for (const path of targets) {
      const stat = await this.plugin.app.vault.adapter.stat(path);
      if (stat) await this._sendFileEvent({ path } as TAbstractFile, false);
    }
    this.xNotify.updatePendingCount(Object.keys(this.unsentSessionEvents).length);
  }

  private _waitForResponse<T extends ServerMsg>(type: T["type"]): Promise<T> {
    return new Promise((resolve) => {
      const check = (msg: ServerMsg): boolean => {
        if (msg.type !== type) return false;
        resolve(msg as T);
        return true;
      };
      this.responseListeners.push(check);
    });
  }

  /**
   * Directly re-uploads every active file with E2EE encryption, bypassing the
   * sync protocol's pendingUploads / sync_done machinery.
   *
   * Why bypass sync? The server sends all file_event_result messages at once.
   * If the WS drops mid-upload, the new session resets pendingUploads and the
   * remaining files are silently skipped.  Here the CLIENT drives the queue
   * sequentially so a disconnect shows progress and can be resumed.
   */
  // True for the duration of the very first sync on a brand-new device
  // (no prior metadata).  Config/settings files are withheld from upload
  // until sync_done so the server's authoritative settings come down first.
  private _isFirstSync = false;

  private _reEncrypting = false;

  async triggerReEncrypt(): Promise<void> {
    if (this._reEncrypting) return;
    if (!this.ws.isConnected) {
      this.xNotify.showNotification(STATUS_WARN, "Re-encrypt: connect to server first");
      return;
    }

    this._reEncrypting = true;
    this._e2eeKey = null;
    this._e2eeKeyPassword = "";

    try {
      await this.storage.bumpAllMtimesForReEncrypt();
      await this.storage.computeTree();

      const paths = Object.entries(this.storage.tree)
        .filter(([, e]) => e.fileType === "file" && e.action === "active")
        .map(([p]) => p);

      if (paths.length === 0) {
        this.xNotify.showNotification("#4caf50", "Re-encrypt: vault is empty");
        return;
      }

      this.plugin.log(`[ReEncrypt] Starting — ${paths.length} files to re-upload`);
      this.xNotify.notifyStatus(NotifyType.SYNCING);

      let done = 0;
      for (const path of paths) {
        if (!this.ws.isConnected) {
          this.xNotify.showNotification(STATUS_WARN,
            `Re-encrypt paused — disconnected after ${done}/${paths.length} files. Press button again to resume.`);
          return;
        }
        try {
          await this._uploadFile(path);
          done++;
          if (done % 25 === 0 || done === paths.length) {
            this.plugin.log(`[ReEncrypt] ${done}/${paths.length} files done`);
          }
        } catch (e) {
          this.plugin.log(`[ReEncrypt] Error on ${path}: ${e}`);
        }
      }

      await this.storage.flushMetadata();
      this.plugin.log(`[ReEncrypt] Complete — ${done}/${paths.length} files re-encrypted`);
      this.xNotify.showNotification("#4caf50", `Re-encryption complete (${done}/${paths.length} files)`);
      this.xNotify.notifyStatus(NotifyType.CONNECTED);
    } finally {
      this._reEncrypting = false;
      this.storage.tree = {};
    }
  }

  async listVersionHistory(path: string): Promise<any> {
    this.ws.send({ type: "file_history", path });
    return this._waitForResponse("file_history_response");
  }

  async downloadVersion(path: string, mtime?: number): Promise<any> {
    this.ws.send({ type: "file_data", mode: "send", path, ...(mtime !== undefined ? { mtime } : {}) });
    return this._waitForResponse("file_data_response");
  }

  /** Derive and return the current E2EE decryption key, or null if E2EE is off. */
  async getE2eeKey(): Promise<CryptoKey | null> {
    return this._getEncryptionKey();
  }

  /**
   * Push a local file to the server immediately, bypassing the debounce timer.
   * Used after a version restore so peers receive the restored content right away
   * rather than waiting for the next sync cycle.
   */
  async pushFile(path: string): Promise<void> {
    await this._sendFileEvent({ path } as TAbstractFile, true);
  }

  addActivity(direction: "up" | "down" | "delete", path: string): void {
    const icon = direction === "up" ? "\u2191" : direction === "down" ? "\u2193" : "\ud83d\uddd1";
    this.activityLog.unshift(`[${new Date().toLocaleTimeString()}] ${icon} ${path}`);
    if (this.activityLog.length > this.MAX_ACTIVITY) this.activityLog.pop();
  }

  getActivityLog(): string[] { return this.activityLog; }

  private async acquireWakeLock(): Promise<void> {
    try { if ("wakeLock" in navigator && !this.wakeLock) this.wakeLock = await (navigator as any).wakeLock.request("screen"); } catch {}
  }

  releaseWakeLock(): void {
    if (this.wakeLock) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
  }
}
