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

  // Cursor sync (phase 2): highest server seq we have applied. Persisted in
  // plugin settings; sent as `since` in sync_cursor. The upload direction is
  // reconciled locally after sync_done (see _reconcileUploads).
  private _lastSyncedSeq = 0;
  // True between sending sync_cursor and receiving sync_done. While set, only
  // ordered session pushes advance the checkpoint; live pushes are deferred.
  private _inCursorSession = false;
  // Highest seq from live (non-session) pushes during a session, folded into the
  // cursor at sync_done once the ordered stream is fully applied.
  private _liveMaxSeq = 0;
  // Throttle timer for persisting the cursor mid-stream (resumable bootstrap).
  private _cursorCheckpointTimer: number | null = null;
  // Highest seq applied per path. Lets a live push that jumped ahead of a sync
  // backlog avoid being clobbered by an older bootstrap push for the same file.
  private _appliedSeq = new Map<string, number>();
  // The full-vault reconcile scan only catches edits made while the app was
  // CLOSED; in-session edits are captured by vault events. So it only needs to
  // run on the first sync after load — reconnect syncs skip the O(vault) scan.
  // Reset to true in load().
  private _needsFullReconcile = true;

  private responseListeners: Array<(msg: ServerMsg) => boolean> = [];
  private messageQueue: ServerMsg[] = [];
  private isProcessingQueue = false;

  // Paths we are actively writing via _applyServerFile.  When the vault fires
  // a create/modify event for one of these paths we suppress it — otherwise the
  // plugin would re-upload the file it just received, which can race with edits
  // on other vaults and produce spurious "Conflicted Copy" files there.
  private _applyingPaths = new Set<string>();

  // Tracks the timestamp when we last wrote a file via _applyServerFile.
  // Used to suppress platform-generated delete events (iOS iCloud eviction,
  // Android post-write cleanup) for files we *just* wrote — those look like
  // real deletes to stat() because the OS actually removes the local copy,
  // but they are spurious: the file still exists on the server.  A 60-second
  // grace window is long enough to catch any platform cleanup burst.
  private _recentlyApplied = new Map<string, number>();

  // ── E2EE key cache ────────────────────────────────────────────────────────
  // PBKDF2 derivation is expensive (~100–200 ms).  Cache the derived key and
  // only re-derive when the password changes.
  private _e2eeKey: CryptoKey | null = null;
  private _e2eeKeyPassword = "";

  private async _getEncryptionKey(): Promise<CryptoKey | null> {
    const { encryptionEnabled } = this.plugin.settings;
    const encryptionPassword = this.plugin.getEncryptionPassword();
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
    this.ws = new WsManager(plugin);
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
    this._lastSyncedSeq = this.plugin.settings.lastSyncedSeq ?? 0;
    this._needsFullReconcile = true; // first sync after load does the offline scan
    // Existing installs that already synced (have metadata) predate the
    // bootstrapComplete flag — mark them complete so they aren't treated as a
    // fresh first-sync (which would wipe their delete queue).
    if (!this.plugin.settings.bootstrapComplete && this.storage.hasAnyMetadata()) {
      this.plugin.settings.bootstrapComplete = true;
      await this.plugin.saveSettings();
    }

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
    // Persist any metadata accumulated during this session.  Without this,
    // metadata written via the 10-second requestSave() debounce is lost if
    // Obsidian closes before sync_done fires (large initial syncs, disconnects,
    // etc.), causing a full re-sync on the next open.
    void this.storage.flushMetadata();
    this.storage.abortTree();
    this.storage.tree = {};
    this.storage.close(); // close IndexedDB connection (no-op on the json path)
    this.xTimeouts.clear();
    this._recentlyApplied.clear();
    if (this.configCheckInterval !== null) {
      window.clearInterval(this.configCheckInterval);
      this.configCheckInterval = null;
    }
    if (this._cursorCheckpointTimer !== null) {
      window.clearTimeout(this._cursorCheckpointTimer);
      this._cursorCheckpointTimer = null;
    }
    this._inCursorSession = false;

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
    // Live file pushes (not part of the ordered cursor stream) jump ahead of a
    // large sync backlog, so a peer's edit shows up promptly even while this
    // device is mid-bootstrap. Same-path ordering is protected by the per-path
    // seq guard in _handleServerMessage.
    if (msg.type === "file_push" && !msg.session) {
      this.messageQueue.unshift(msg);
    } else {
      this.messageQueue.push(msg);
    }
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
        // Fire the upload without awaiting — lets the message queue keep processing
        // while multiple uploads run concurrently.  The server bounds concurrency
        // via UPLOAD_BATCH (pendingUploads set) so we never flood the connection.
        if (msg.result === "client_newer") void this._uploadFile(msg.path);
        else if (msg.result === "conflict") {
          // Server detected a concurrent edit and kept its version. Our local
          // content was preserved server-side as a "(Conflicted Copy …)" file,
          // which arrives via file_push along with the server's head version.
          this.plugin.log(`[Conflict] ${msg.path} was edited elsewhere — local edits saved as a conflicted copy`);
          this.addActivity("down", msg.path);
          this.xNotify.showNotification(STATUS_WARN, `Sync conflict: ${msg.path} — your edits were saved as a conflicted copy`);
        }
        break;
      case "file_push": {
        // Skip applying a push that is older than what we already applied for
        // this path — happens when a live edit jumped ahead of the bootstrap
        // stream and an older session push for the same file arrives later.
        const prior = this._appliedSeq.get(msg.file.path);
        const stale = typeof msg.seq === "number" && prior !== undefined && msg.seq < prior;
        if (!stale) {
          await this._applyServerFile(msg.file, msg.content);
          // Only record seq for LIVE pushes (the ones that can jump ahead). Ordered
          // session pushes never overtake each other, so tracking them would just
          // bloat the map to vault size during a bootstrap — wasteful on low RAM.
          if (typeof msg.seq === "number" && !msg.session) this._appliedSeq.set(msg.file.path, msg.seq);
        }
        if (typeof msg.seq === "number") {
          if (msg.session) {
            // Ordered session push: everything up to this seq is now applied, so
            // it is safe to checkpoint. Persist incrementally so an interrupted
            // bootstrap resumes from here instead of restarting from 0.
            if (msg.seq > this._lastSyncedSeq) this._lastSyncedSeq = msg.seq;
            this._scheduleCursorCheckpoint();
          } else if (this._inCursorSession) {
            // Live push arriving mid-session: applied now, but its seq is ahead of
            // the ordered stream — defer it to sync_done so we don't checkpoint a
            // gap over un-applied session files.
            if (msg.seq > this._liveMaxSeq) this._liveMaxSeq = msg.seq;
          } else {
            // Live push while idle (already caught up): safe to advance + persist.
            if (msg.seq > this._lastSyncedSeq) this._lastSyncedSeq = msg.seq;
            this._scheduleCursorCheckpoint();
          }
        }
        break;
      }
      case "sync_done":
        if (typeof msg.cursor === "number" && msg.cursor > this._lastSyncedSeq) {
          this._lastSyncedSeq = msg.cursor;
        }
        if (msg.more) {
          // Bounded batch finished and more remain — checkpoint progress and pull
          // the next batch. Only one batch is ever in flight, capping memory.
          // Stay in-session; do NOT finalize (uploads/reconcile wait for the end).
          this._scheduleCursorCheckpoint();
          // Pace to the device: writing the batch triggers Obsidian's indexer, so
          // yield the main thread back to it before pulling more — otherwise a
          // slow device (e.g. an old Surface) crawls under the combined load.
          // Done off the message queue so live edits stay responsive meanwhile.
          void this._waitForIdle().then(() => {
            if (this.ws.isConnected && this._inCursorSession) {
              this.ws.send({ type: "sync_cursor", since: this._lastSyncedSeq });
            }
          });
          break;
        }
        // Final batch — fold in any live edges that landed during the session
        // (everything ≤ those seqs is now on disk), then finalize.
        this._inCursorSession = false;
        if (this._liveMaxSeq > this._lastSyncedSeq) this._lastSyncedSeq = this._liveMaxSeq;
        this._liveMaxSeq = 0;
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
        // Acknowledge the file in metadata WITHOUT writing content.  This stores
        // the server's encrypted SHA so the next sync message includes this path
        // with the correct SHA, causing compareFiles to return null and stopping
        // the server from re-pushing the file on every connect.
        await this.storage.writeMetadata(file);
        return;
      }
      try {
        // `key` above only guards that E2EE is configured; decrypt derives the
        // version-correct key from the password (handles legacy v1 blobs too).
        const plainBytes = await decryptFromBase64(content, this.plugin.getEncryptionPassword());
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

          // Capture the content here so _createConflictedCopy can reuse it.
          // If we let _createConflictedCopy re-read the file independently, Obsidian
          // may rewrite the file in the background between this read and that read,
          // producing a "conflict copy" that contains the server's content rather than
          // the local content we were trying to preserve (a phantom conflict).
          let capturedContent: string | ArrayBuffer | null = null;
          if (isBinary) {
            const buf = await this.storage.readBinary(file.path);
            capturedContent = buf;
            if (buf && (await Utils.getSHABinary(buf)) === file.sha1) isSame = true;
          } else {
            const txt = await this.storage.read(file.path);
            capturedContent = txt;
            if (txt !== null && (await Utils.getSHA(txt)) === file.sha1) isSame = true;
          }

          // Hidden/config files (.obsidian/**) flap constantly between devices;
          // conflicted copies of them are junk that multiplies on every flap.
          // Let the incoming version win silently for those paths.
          const isConfigLike = file.path.startsWith(".") || file.path.includes("/.");
          if (!isSame && !isConfigLike) {
            this.plugin.log(`[Conflict] ${file.path} modified offline. Backing up.`);
            await this._createConflictedCopy(file.path, capturedContent ?? undefined);
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
        // Register the path before deleting so the vault "delete" event that
        // fires from storage.delete() is suppressed in _processLocalEvent.
        // Without this, the deletion would be re-queued in the delete queue,
        // then re-sent to the server, then re-pushed back — an infinite loop.
        this._applyingPaths.add(file.path);
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
            else await this.storage.write(file.path, content, file, /* withShadow */ false);
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

        // Mark this path as recently applied so any platform-generated delete
        // event within the next 60 seconds is treated as spurious (e.g. iCloud
        // eviction on iOS).  The entry is checked — and cleaned up — inside
        // _processLocalEvent before the stat check.
        this._recentlyApplied.set(file.path, Date.now());

        this._reloadObsidianConfig(file.path);
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

  /**
   * Saves a copy of the local file before the server version overwrites it.
   *
   * `capturedContent` is the content already read by the caller for the sha1
   * comparison.  Reusing it avoids a second disk read and — more importantly —
   * eliminates the race where Obsidian rewrites the file between the sha1 check
   * and this function, which would cause the conflict copy to contain the
   * server's content rather than the local edits we're trying to preserve.
   */
  private async _createConflictedCopy(originalPath: string, capturedContent?: string | ArrayBuffer): Promise<void> {
    const date = new Date();
    const ts = date.toISOString().replace(/[:.]/g, "-").slice(0, 16);
    // Extension = dot inside the basename only (not folder dots, not a leading dot).
    const lastSlash = originalPath.lastIndexOf("/");
    const lastDot = originalPath.lastIndexOf(".");
    const hasExt = lastDot > lastSlash + 1;
    const pathNoExt = hasExt ? originalPath.slice(0, lastDot) : originalPath;
    const ext = hasExt ? originalPath.slice(lastDot) : "";
    const newPath = `${pathNoExt} (Conflicted Copy ${ts})${ext}`;

    if (Utils.isBinary(originalPath)) {
      const buf = capturedContent instanceof ArrayBuffer
        ? capturedContent
        : await this.storage.readBinary(originalPath);
      if (buf) await this.plugin.app.vault.adapter.writeBinary(newPath, buf);
    } else {
      const txt = typeof capturedContent === "string"
        ? capturedContent
        : await this.storage.read(originalPath);
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
    // Used to block the delete-queue drain during first sync (prevents spurious
    // platform delete events from wiping the vault on first connect).
    // First sync = bootstrap not yet completed. Using a persisted flag (rather
    // than "has any metadata") means an interrupted, partially-applied bootstrap
    // is still treated as first-sync, keeping the delete-queue safety guard.
    this._isFirstSync = !this.plugin.settings.bootstrapComplete;
    if (this._isFirstSync) {
      this.plugin.log("[IonSync] First sync (bootstrap incomplete) — delete queue drain deferred until sync_done");
    }

    try {
      for (const [, ev] of Object.entries(this.unsentSessionEvents)) {
        await this._processLocalEvent(ev.action, ev.file, false);
      }
      this.unsentSessionEvents = {};

      await this.acquireWakeLock();
      this.xNotify.notifyStatus(NotifyType.SYNCING);

      // Cursor sync (phase 2): ask the server for everything changed since our
      // cursor instead of sending the whole tree and having the server diff it.
      // A different endpoint means the cursor is meaningless → bootstrap from 0.
      // The UPLOAD direction is reconciled locally in _onSyncDone, AFTER the
      // server's changes are applied — that ordering is what stops a fresh device
      // from re-uploading (and clobbering) the config it just received.
      const endpoint = this._endpointKey();
      if (this.plugin.settings.lastSyncedEndpoint !== endpoint) {
        this.plugin.log(
          `[IonSync] Endpoint changed (${this.plugin.settings.lastSyncedEndpoint || "none"} → ${endpoint}) — bootstrapping from seq 0`
        );
        this._lastSyncedSeq = 0;
      }
      this._inCursorSession = true;
      this._liveMaxSeq = 0;
      this._appliedSeq.clear();
      this.ws.send({ type: "sync_cursor", since: this._lastSyncedSeq });
    } catch (e) {
      this.isSyncing = false;
      this._inCursorSession = false;
      this.releaseWakeLock();
      this.xNotify.notifyStatus(this.ws.isConnected ? NotifyType.CONNECTED : NotifyType.NOT_CONNECTED);
    }
  }

  private async _onSyncDone(): Promise<void> {
    const wasFirstSync = this._isFirstSync;
    this._isFirstSync = false;  // device is now fully synced
    // NOTE: isSyncing stays TRUE until the end of this method. It suppresses the
    // 5-second config poller (_checkConfigFiles) while we reconcile uploads, so a
    // fresh device cannot upload its local config before the server's config has
    // been applied — the original cause of fresh devices clobbering settings.

    // Clear any stale _applyingPaths entries.  Normally each entry is consumed
    // as its vault event fires, but folder paths added during makeFolder calls
    // may never receive a matching event (e.g. folder already existed).
    this._applyingPaths.clear();

    // Download direction complete — persist the cursor we are now caught up to,
    // and mark the bootstrap finished so future syncs are treated as deltas.
    if (this._cursorCheckpointTimer !== null) {
      window.clearTimeout(this._cursorCheckpointTimer);
      this._cursorCheckpointTimer = null;
    }
    this.plugin.settings.lastSyncedSeq = this._lastSyncedSeq;
    this.plugin.settings.lastSyncedEndpoint = this._endpointKey();
    this.plugin.settings.bootstrapComplete = true;
    await this.plugin.saveSettings();

    // UPLOAD direction: now that server changes are applied and metadata reflects
    // them, scan the vault and upload only paths whose content genuinely differs.
    await this._reconcileUploads();

    // After a first-ever sync, discard every delete-queue entry that accumulated
    // during the initial write burst.  The platform (iOS iCloud eviction, Android
    // post-write cleanup) fires delayed "delete" events for files it just wrote,
    // which pile up in the delete queue while _isFirstSync was blocking the drain.
    // Now that _isFirstSync is false those would be drained immediately and sent
    // to the server as real deletes — causing mass deletion on every other device.
    // A brand-new device has zero legitimate deletes: it just received the world
    // from the server.  Wipe the queue; the server is authoritative for anything
    // that turns out to be truly missing.
    if (wasFirstSync) {
      const blocked = Object.keys(this.deleteQueue);
      if (blocked.length > 0) {
        this.plugin.log(`[IonSync] First sync complete — discarding ${blocked.length} queued delete(s) from initial write burst: ${blocked.slice(0, 3).join(", ")}${blocked.length > 3 ? " ..." : ""}`);
        this.deleteQueue = {};
        await this.storage.saveDeleteQueue(this.deleteQueue);
      }
    }

    // After the first sync, schedule a cleanup of the recently-applied map
    // once the 60-second grace window has expired, so we don't hold 20k+
    // path strings in memory indefinitely on devices with large vaults.
    if (wasFirstSync) {
      setTimeout(() => { this._recentlyApplied.clear(); }, 65_000);
    }

    // Drain any offline delete-queue entries that accumulated while disconnected.
    // We do this here (after reconciliation) rather than in _onConnected so that:
    //   1. _isFirstSync is already cleared (or the queue was wiped by wasFirstSync)
    //   2. The server has pushed any files it still considers active, so the
    //      stat-check inside _processDeleteQueue can drop stale iCloud evictions
    //      for files that just got re-downloaded.
    if (!wasFirstSync && Object.keys(this.deleteQueue).length > 0) {
      await this._processDeleteQueue();
    }

    this.releaseWakeLock();
    this.xNotify.setSyncSummary(this.syncUpCount, this.syncDownCount);
    this.syncUpCount = 0;
    this.syncDownCount = 0;
    this.syncApplyCount = 0;
    this.storage.tree = {};
    await this.storage.flushMetadata();
    // Backlog is drained; drop the per-path seq guard (live edits now apply in
    // order anyway). Bounds memory after a large bootstrap.
    this._appliedSeq.clear();
    this.isSyncing = false;
  }

  /**
   * Resolve once the app has idle time (or after `timeoutMs` as a safety net).
   * Used to pace the batched bootstrap: each applied batch fires a burst of vault
   * events that Obsidian indexes, and pulling the next batch before that settles
   * makes a slow device crawl. Yielding to idle keeps it responsive. Falls back
   * to a short delay where requestIdleCallback is unavailable (some mobile
   * webviews).
   */
  private _waitForIdle(timeoutMs = 2_000): Promise<void> {
    return new Promise((resolve) => {
      const ric = (window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
      }).requestIdleCallback;
      if (typeof ric === "function") ric(() => resolve(), { timeout: timeoutMs });
      else setTimeout(resolve, 50);
    });
  }

  /** Stable key for the current server endpoint, used to invalidate the cursor. */
  private _endpointKey(): string {
    const { host, port, tls } = this.plugin.settings;
    return `${host}:${port}:${tls ? "tls" : "tcp"}`;
  }

  /**
   * Throttled mid-stream checkpoint of the cursor (resumable bootstrap). Fires
   * at most once every 2s while a long session streams in. It flushes metadata
   * FIRST so the persisted cursor is never ahead of durable file state — on a
   * crash the cursor points at files we definitely wrote, and the rest is simply
   * re-pulled on the next sync.
   */
  private _scheduleCursorCheckpoint(): void {
    if (this._cursorCheckpointTimer !== null) return; // throttle: already scheduled
    this._cursorCheckpointTimer = window.setTimeout(async () => {
      this._cursorCheckpointTimer = null;
      try {
        await this.storage.flushMetadata();
        this.plugin.settings.lastSyncedSeq = this._lastSyncedSeq;
        this.plugin.settings.lastSyncedEndpoint = this._endpointKey();
        await this.plugin.saveSettings();
      } catch (e) {
        this.plugin.log(`[IonSync] cursor checkpoint failed: ${e}`);
      }
    }, 2_000);
  }

  /**
   * Upload direction for cursor sync. Runs AFTER server changes are applied so
   * metadata reflects the server's head — that ordering prevents a fresh device
   * from re-uploading (and overwriting) config it just received. Scans the vault
   * and uploads only paths whose content differs from last-synced metadata.
   *
   * Offline DELETES are intentionally not propagated here: the legacy full-list
   * sync never propagated them either (it resurrected missing files), and a
   * tree-diff delete would be dangerous on mobile where files can transiently
   * vanish from the index (iCloud eviction). Deletes flow through vault events.
   */
  private async _reconcileUploads(): Promise<void> {
    if (!this.ws.isConnected) return;
    // Only scan once per app load. The scan exists to catch edits made while the
    // app was closed; anything edited in-session is already captured by vault
    // events, so re-scanning on every reconnect is wasted O(vault) work + a full
    // tree allocation + a config-dir stat — a real drag on slow devices.
    if (!this._needsFullReconcile) return;
    await this.storage.computeTree();

    const changed: string[] = [];
    for (const [path, entry] of Object.entries(this.storage.tree)) {
      if (entry.action !== "active" || entry.fileType !== "file") continue;
      if (this.exclusionFilter?.isExcluded(path)) continue;
      const stored = this.storage.readMetadata(path);
      // No metadata = new local file; differing sha = edited offline. computeTree
      // reuses the stored entry verbatim when mtime is unchanged, so unchanged
      // files compare equal here and are skipped.
      if (!stored || stored.sha1 !== entry.sha1) changed.push(path);
    }
    // Offline scan complete for this app session — don't repeat it on reconnects.
    this._needsFullReconcile = false;

    if (changed.length === 0) return;
    this.plugin.log(`[IonSync] Cursor reconcile: uploading ${changed.length} local change(s)`);
    for (const path of changed) {
      if (!this.ws.isConnected) break;
      try { await this._uploadFile(path); }
      catch (e) { this.plugin.log(`[IonSync] reconcile upload failed for ${path}: ${e}`); }
    }
  }

  private async _uploadFile(path: string): Promise<void> {
    if (!this.ws.isConnected) return;

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
    // baseSha1 = the sha we last synced for this path (see _sendFileEvent).
    this.ws.send({ type: "file_data", mode: mode as any, file: entry, content, ...(stored?.sha1 ? { baseSha1: stored.sha1 } : {}) });
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
      // Verify the file is actually gone before treating this as a real deletion.
      // Mobile platforms (iOS/Android) can fire spurious "delete" events for paths
      // that still exist — for example:
      //   • iCloud evicts a file to cloud-only storage right after writing it
      //   • ENOTDIR cleanup via trashFile fires an extra event on the parent path
      //   • An in-progress write triggers a transient remove+recreate at the OS level
      // Without this check, those phantom events reach the server as real deletes,
      // causing the file to be deleted on every other connected device.
      // Grace-window guard: drop delete events for files we wrote very recently.
      // On iOS, iCloud evicts newly-written files from local storage after sync_done
      // fires, triggering vault delete events whose stat() call returns null (the
      // file is genuinely gone from disk, but still safe on the server).  Without
      // this check those events become real deletes and get broadcast to every
      // other connected device.  60 seconds is wide enough to cover any eviction
      // burst but short enough that a deliberate user-delete is not delayed more
      // than one sync cycle.
      const appliedAt = this._recentlyApplied.get(file.path);
      if (appliedAt !== undefined) {
        this._recentlyApplied.delete(file.path); // one-shot: consume the entry
        if (Date.now() - appliedAt < 60_000) {
          this.plugin.log(`[IonSync] Grace-window: dropping delete for recently-applied file ${file.path} (${Date.now() - appliedAt}ms after write)`);
          return;
        }
      }

      let existsStat = null;
      try {
        existsStat = await this.plugin.app.vault.adapter.stat(file.path);
      } catch {
        // stat() failure means we can't confirm the file is gone — treat as
        // spurious and drop the delete rather than risk sending a bad delete.
        this.plugin.log(`[IonSync] stat() failed for delete event on ${file.path} — dropping to be safe`);
        return;
      }
      if (existsStat) {
        this.plugin.log(`[IonSync] Dropping spurious delete event for ${file.path} (file still exists on disk)`);
        return;
      }

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

    // Lower floor (0.75s) so an edit propagates to other devices quickly while
    // still batching a typing burst (the prior 2s floor felt laggy). A larger
    // delayedSync setting is still honored. Config files keep a 5s delay — they
    // flap constantly and have no merge value.
    let delay = Math.max(this.plugin.settings.delayedSync ?? 0, 0.75);
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

    // Content is byte-identical to what we last synced — only the mtime moved
    // (a `touch`, a metadata shuffle, an iCloud eviction/redownload). Sending
    // would just be an idempotent no-op the server accepts (sha1 == head) after
    // uselessly broadcasting to every peer. Skip the upload; refresh the stored
    // mtime so we don't re-hash this path on the next spurious event. Honour
    // forceChanged (version restore / pushFile) which must always send.
    if (!forceChanged && sha1 && stored?.sha1 === sha1) {
      await this.storage.writeMetadata({ path: file.path, sha1, mtime: stat.mtime, action: "active", fileType: "file" });
      return;
    }

    const entry: FileEntry = { path: file.path, sha1: sha1 ?? "", mtime: stat.mtime, action: "active", fileType: "file" };
    // baseSha1 = the sha we last synced for this path. The server uses it to
    // detect concurrent edits (stale base) without trusting device clocks.
    this.ws.send({ type: "file_data", mode: mode as any, file: entry, content, ...(stored?.sha1 ? { baseSha1: stored.sha1 } : {}) });
    await this.storage.writeMetadata(entry);
    this.addActivity("up", file.path);
  }

  // ── Utility ──────────────────────────────────────────────────────────────

  private async _onConnected(): Promise<void> {
    this.xNotify.notifyStatus(NotifyType.CONNECTED);
    // NOTE: the delete queue is intentionally NOT drained here.
    // Draining on connect is dangerous because _isFirstSync has not yet been set
    // (that happens inside sync()), and the queue may contain stale entries from
    // iCloud evictions in a previous session.  If we drain before reconciliation
    // the server records those files as deleted and broadcasts mass deletions to
    // every other connected device.  Instead we drain in _onSyncDone, after the
    // server has had a chance to push back any files it still considers active
    // (which makes the stat-check drop the stale delete entries naturally).
    // Real-time deletes (user deletes a file while connected) still go through
    // _processDeleteQueue immediately via _processLocalEvent — unaffected.

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
    // Distinguish a deliberate pause from a dropped connection.
    this.xNotify.notifyStatus(
      this.plugin.settings.syncEnabled ? NotifyType.CONNECTION_LOST : NotifyType.PLUGIN_DISABLED
    );
    this.isSyncing = false;
    this._inCursorSession = false;
    // Drop any buffered server messages (e.g. a large bootstrap backlog). Without
    // this, a pause/disconnect keeps grinding through every already-received
    // file_push — applying files and resetting the status to "Syncing" — even
    // though the socket is closed. The cursor resumes from its last checkpoint on
    // reconnect, so nothing is lost.
    this.messageQueue = [];
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
    // Never drain the delete queue during the very first sync session.
    // A brand-new device is only *receiving* the world — any delete events it
    // fires during the initial write burst are noise (platform timing, iCloud
    // placeholders, ENOTDIR cleanup, etc.).  Letting them through would cause
    // the server to mark live files as deleted and broadcast that to every peer.
    if (this._isFirstSync) {
      const blocked = Object.keys(this.deleteQueue);
      if (blocked.length > 0) {
        this.plugin.log(`[IonSync] _isFirstSync: blocking delete queue drain (${blocked.length} entries): ${blocked.slice(0, 5).join(", ")}${blocked.length > 5 ? " ..." : ""}`);
      }
      return;
    }
    const paths = Object.keys(this.deleteQueue);
    if (paths.length === 0) return;
    this.isProcessingDeleteQueue = true;
    try {
      for (const path of paths) {
        // Safety check: only send the delete if the file is actually gone from
        // disk.  Spurious vault "delete" events (e.g. from ENOTDIR collision
        // during folder creation, a.k.a. Bug 5) can land in the delete queue for
        // files that still exist.  Sending a delete for a live file corrupts the
        // server state — the server marks it deleted, then pushes the deletion
        // back to this device, which then actually deletes the file, causing
        // real data loss and a re-download loop on every connect.
        const stat = await this.plugin.app.vault.adapter.stat(path);
        if (stat) {
          // File still exists — spurious delete event.  Drop it silently.
          console.log(`[IonSync] Dropping spurious delete queue entry for ${path} (file still exists)`);
          delete this.deleteQueue[path];
          continue;
        }

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

  /**
   * After writing a config file received from the server, ask Obsidian to
   * reload the relevant subsystem so the change takes effect without a restart.
   *
   * - appearance.json  → requestLoadTheme() re-reads the file and applies the
   *                      accent colour, base theme, and font settings live.
   * - themes/** / snippets/** → readCssSources() reloads all CSS sources.
   *
   * Both APIs are internal (not in the public typings) — the optional-chaining
   * calls are intentional so a future Obsidian rename doesn't throw at runtime.
   */

  private _reloadObsidianConfig(path: string): void {
    const configDir = this.plugin.app.vault.configDir;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const css = (this.plugin.app as any).customCss;
    if (!css) return;

    if (path === `${configDir}/appearance.json`) {
      css.requestLoadTheme?.();
    } else if (
      path.startsWith(`${configDir}/themes/`) ||
      path.startsWith(`${configDir}/snippets/`)
    ) {
      css.readCssSources?.();
    }
  }

  private async _checkConfigFiles(): Promise<void> {
    if (!this.ws.isConnected || !this.plugin.settings.autoSync || this.isSyncing) return;
    const configDir = this.plugin.app.vault.configDir;
    // Seed with the well-known singleton config files.
    const targets: string[] = [
      `${configDir}/app.json`,
      `${configDir}/appearance.json`,
      `${configDir}/hotkeys.json`,
      `${configDir}/community-plugins.json`,
      `${configDir}/core-plugins.json`,
      `${configDir}/core-plugins-migration.json`,
    ].filter(p => !this.exclusionFilter?.isExcluded(p));

    // Vault events don't fire for .obsidian/ changes, so we must poll.
    // Add every .json sitting directly in .obsidian/ (core plugin settings
    // like daily-notes.json, templates.json, etc.) then each plugin's data.json.
    try {
      const listing = await this.plugin.app.vault.adapter.list(configDir);
      for (const f of listing.files) {
        if (f.endsWith(".json") && !targets.includes(f) && !this.exclusionFilter?.isExcluded(f))
          targets.push(f);
      }
    } catch { /* configDir unreadable — skip */ }

    if (this.plugin.settings.syncInstalledCommunityPlugins) {
      try {
        const pluginsDir = `${configDir}/plugins`;
        const listing = await this.plugin.app.vault.adapter.list(pluginsDir);
        for (const folder of listing.folders) {
          const dataPath = `${folder}/data.json`;
          if (!this.exclusionFilter?.isExcluded(dataPath)) targets.push(dataPath);
        }
      } catch { /* plugins dir unreadable — skip */ }
    }

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
