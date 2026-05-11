import type { FileEntry, ServerMsg, BackgroundSyncReq } from "@ionsync/protocol";
import type { TAbstractFile } from "obsidian";
import { WsManager, type UpdateInfo } from "./WsManager.js";
import { Storage } from "./Storage.js";
import { XNotify, NotifyType } from "./XNotify.js";
import { XTimeouts } from "./XTimeouts.js";
import { ExclusionFilter } from "./ExclusionFilter.js";
import Utils from "./Utils.js";
import type { IonSyncPlugin } from "./main.js";
import { diff_match_patch } from "diff-match-patch"; // ✅ Phase 2 Import

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

  private configCheckInterval: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  private inited = false;
  private isEnabled = false;

  private responseListeners: Array<(msg: ServerMsg) => boolean> = [];
  private messageQueue: ServerMsg[] = [];
  private isProcessingQueue = false;

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
          content = Buffer.from(buf).toString("base64");
          sha1 = await Utils.getSHABinary(buf);
        }
      } else {
        const txt = await this.storage.read(ev.file.path);
        if (txt !== null) {
          content = Buffer.from(txt).toString("base64");
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
    // ✅ Emergency Guard: Instantly drop massive developer folders
    if (file.path.includes("node_modules/") || file.path.includes(".git/")) {
      return;
    }

    if (this.exclusionFilter?.isExcluded(file.path)) return;

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
        await this.storage.delete(file.path, file);
        this.addActivity("delete", file.path);
      } else if (file.fileType === "folder") {
        if (localStat && localStat.type === "file") return;
        await this.storage.makeFolder(file.path, file);
      } else {
        if (localStat && localStat.type === "folder") return;

        if (Utils.isBinary(file.path)) await this.storage.writeBinary(file.path, content, file);
        else await this.storage.write(file.path, content, file);
        
        this.addActivity("down", file.path);
        this.syncDownCount++;
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
    this.releaseWakeLock();
    this.xNotify.setSyncSummary(this.syncUpCount, this.syncDownCount);
    this.syncUpCount = 0;
    this.syncDownCount = 0;
    this.storage.tree = {};
    await this.storage.flushMetadata();
  }

  // ✅ PHASE 2: Delta Sync integration for bulk uploads
  private async _uploadFile(path: string): Promise<void> {
    if (!this.ws.isConnected) return;

    // ✅ Emergency Fix: Hardcoded safety net for all media types so we NEVER text-diff an image
    const hardcodedBinaryCheck = /\.(jpeg|jpg|png|gif|bmp|webp|ico|svg|pdf|mp3|mp4|wav|mov|zip|rar|7z)$/i.test(path);
    const isBinary = Utils.isBinary(path) || hardcodedBinaryCheck;

    const stored = this.storage.readMetadata(path);
    const entry: FileEntry | null = (this.storage.tree[path] ?? stored) ?? null;
    if (!entry) return;

    let content = "";
    let mode: "apply" | "patch" = "apply";
    let liveSha1 = entry.sha1; 

    if (entry.action === "active" && entry.fileType === "file") {
      if (isBinary) {
        const buf = await this.storage.readBinary(path);
        if (buf) {
          // ✅ Wrap ArrayBuffer in Uint8Array for flawless Base64 conversion
          content = Buffer.from(new Uint8Array(buf)).toString("base64");
          liveSha1 = (await Utils.getSHABinary(buf)) ?? ""; 
        }
      } else {
        const currentText = await this.storage.read(path);
        if (currentText !== null) {
          liveSha1 = (await Utils.getSHA(currentText)) ?? ""; 
          
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
              content = Buffer.from(currentText).toString("base64");
            }
          } else {
            content = Buffer.from(currentText).toString("base64");
          }
          await this.storage.writeShadow(path, currentText);
        }
      }
    }

    entry.sha1 = liveSha1;

    // Bypass TS cache with 'as any'
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

  // ✅ PHASE 2: Delta Sync integration for active live-sync edits
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

    if (isBinary) {
      const buf = await this.storage.readBinary(file.path);
      if (buf) { 
        sha1 = await Utils.getSHABinary(buf); 
        content = Buffer.from(buf).toString("base64"); 
      }
    } else {
      const currentText = await this.storage.read(file.path);
      if (currentText !== null) { 
        sha1 = await Utils.getSHA(currentText); 
        
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
            content = Buffer.from(currentText).toString("base64");
          }
        } else {
          content = Buffer.from(currentText).toString("base64");
        }
        await this.storage.writeShadow(file.path, currentText);
      }
    }

    const entry: FileEntry = { path: file.path, sha1: sha1 ?? "", mtime: stat.mtime, action: "active", fileType: "file" };
    // ✅ Bypass TS cache with 'as any'
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

  async listVersionHistory(path: string): Promise<any> {
    this.ws.send({ type: "file_history", path });
    return this._waitForResponse("file_history_response");
  }

  async downloadVersion(path: string): Promise<any> {
    this.ws.send({ type: "file_data", mode: "send", path });
    return this._waitForResponse("file_data_response");
  }

  addActivity(direction: "up" | "down" | "delete", path: string): void {
    const icon = direction === "up" ? "↑" : direction === "down" ? "↓" : "🗑";
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