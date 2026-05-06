import type { FileEntry, ServerMsg } from "@ionsync/protocol";
import type { TAbstractFile } from "obsidian";
import { WsManager, type UpdateInfo } from "./WsManager.js";
import { Storage } from "./Storage.js";
import { XNotify, NotifyType } from "./XNotify.js";
import { XTimeouts } from "./XTimeouts.js";
import { ExclusionFilter } from "./ExclusionFilter.js";
import Utils from "./Utils.js";
import type { IonSyncPlugin } from "./main.js";

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
  private eventRefs: Record<string, object> = {};

  private deleteQueue: Record<string, DeleteQueueEntry> = {};
  private isProcessingDeleteQueue = false;

  private unsentSessionEvents: Record<string, { action: VaultAction; file: TAbstractFile }> = {};
  private activityLog: string[] = [];
  private readonly MAX_ACTIVITY = 200;

  private syncUpCount = 0;
  private syncDownCount = 0;

  private reconnectDelay = 1_000;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private configCheckInterval: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  private inited = false;
  private isEnabled = false;

  // One-shot response listeners keyed by msg.type
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
    this.exclusionFilter = new ExclusionFilter(this.plugin.settings);

    await this.storage.init();
    this.deleteQueue = await this.storage.loadDeleteQueue();

    this._registerVaultEvent("create");
    this._registerVaultEvent("modify");
    this._registerVaultEvent("delete");
    this._registerVaultEvent("rename");

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

  // ── Connection events ─────────────────────────────────────────────────────

  private async _onConnected(): Promise<void> {
    this.reconnectDelay = 1_000;
    this.xNotify.notifyStatus(NotifyType.CONNECTED);

    if (Object.keys(this.deleteQueue).length > 0) await this._processDeleteQueue();

    if (this.plugin.settings.autoSync) await this.sync();
    else this.xNotify.notifyStatus(NotifyType.AUTO_SYNC_DISABLED);
  }

  private _onDisconnected(): void {
    this.xNotify.notifyStatus(NotifyType.CONNECTION_LOST);
    this.isSyncing = false;
    this.releaseWakeLock();
    this.storage.abortTree();
    this.storage.tree = {};
    this.messageQueue = [];
    this.isProcessingQueue = false;
  }

  private async _onUpdateAvailable(update: UpdateInfo): Promise<void> {
    await this.storage.updatePlugin(update.files);
    this.xNotify.showNotification("#ffaa00", "Plugin updated — reloading…");
    await (this.plugin.app as any).plugins.disablePlugin("ion-sync");
    await (this.plugin.app as any).plugins.enablePlugin("ion-sync");
  }

  // ── Incoming server messages ──────────────────────────────────────────────

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
    // Give one-shot listeners first crack
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

  // ── Sync ──────────────────────────────────────────────────────────────────

  async sync(): Promise<void> {
    if (!this.ws.isConnected || this.isSyncing) return;
    this.plugin.log("Starting sync...");
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

      this.plugin.log(`Syncing ${files.length} files`);

      // Always send at least one sync message (triggers sync_done for empty vault).
      // Multi-chunk syncs: mark every chunk except the last with last:false so the
      // server accumulates all entries before processing. The final chunk is last:true
      // (or omitted, which the server also treats as true for backward-compat).
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
      console.error("[XSync] sync error:", e);
      this.isSyncing = false;
      this.releaseWakeLock();
      this.xNotify.notifyStatus(this.ws.isConnected ? NotifyType.CONNECTED : NotifyType.NOT_CONNECTED);
    }
  }

  private async _onSyncDone(): Promise<void> {
    this.plugin.log("Sync done");
    this.isSyncing = false;
    this.releaseWakeLock();
    this.xNotify.setSyncSummary(this.syncUpCount, this.syncDownCount);
    this.syncUpCount = 0;
    this.syncDownCount = 0;
    this.storage.tree = {};
    await this.storage.flushMetadata();
  }

  // ── File upload ───────────────────────────────────────────────────────────

  private async _uploadFile(path: string): Promise<void> {
    if (!this.ws.isConnected) return;
    this.plugin.log("Uploading:", path);
    const isBinary = Utils.isBinary(path);
    const stored = this.storage.readMetadata(path);
    const entry: FileEntry | null = (this.storage.tree[path] ?? stored) ?? null;
    if (!entry) return;

    let content = "";
    if (entry.action === "active" && entry.fileType === "file") {
      if (isBinary) {
        const buf = await this.storage.readBinary(path);
        if (buf) { content = Buffer.from(buf).toString("base64"); await new Promise<void>((r) => setTimeout(r, 0)); }
      } else {
        const txt = await this.storage.read(path);
        if (txt != null) content = Buffer.from(txt).toString("base64");
      }
    }

    this.ws.send({ type: "file_data", mode: "apply", file: entry, content });
    this.addActivity("up", path);
    this.syncUpCount++;
    await this.storage.writeMetadata(entry);
  }

  // ── File download (from server push) ─────────────────────────────────────

  private async _applyServerFile(file: FileEntry, content: string): Promise<void> {
    if (this.exclusionFilter?.isExcluded(file.path)) return;
    this.plugin.log("Applying server file:", file.path, file.action);
    if (file.action === "deleted") {
      await this.storage.delete(file.path, file);
      this.addActivity("delete", file.path);
    } else if (file.fileType === "folder") {
      await this.storage.makeFolder(file.path, file);
    } else {
      if (Utils.isBinary(file.path)) {
        await this.storage.writeBinary(file.path, content, file);
      } else {
        await this.storage.write(file.path, content, file);
      }
      this.addActivity("down", file.path);
      this.syncDownCount++;
    }
  }

  // ── Real-time vault events ────────────────────────────────────────────────

  private _registerVaultEvent(type: VaultAction): void {
    this.eventRefs[type] = this.plugin.app.vault.on(type as any, async (file: TAbstractFile, ...args: unknown[]) => {
      if (!this.isEnabled) return;
      try { await this._processLocalEvent(type, file, false, args); }
      catch (e) { console.error(`[XSync] vault event error (${type}):`, e); }
    });
  }

  async _processLocalEvent(
    action: VaultAction,
    file: TAbstractFile,
    forceChanged = false,
    args: unknown[] = []
  ): Promise<void> {
    if (this.exclusionFilter?.isExcluded(file.path)) return;
    this.plugin.log("Local event:", action, file.path);

    if ((action === "create" || action === "modify") && this.deleteQueue[file.path]) {
      delete this.deleteQueue[file.path];
      await this.storage.saveDeleteQueue(this.deleteQueue);
    }

    if (action === "rename") {
      const oldPath = args[0] as string;
      this.plugin.log("Rename event:", oldPath, "->", file.path);
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
      this.plugin.log("Queueing event (offline/manual):", action, file.path);
      this.unsentSessionEvents[file.path] = { action, file };
      this.xNotify.updatePendingCount(Object.keys(this.unsentSessionEvents).length);
      return;
    }

    const delay = this.plugin.settings.delayedSync ?? 0;
    if (action === "modify" && delay > 0) {
      this.plugin.log("Debouncing modify event:", file.path, delay, "s");
      this.xTimeouts.set(file.path, delay * 1_000, async () => {
        await this._sendFileEvent(file, forceChanged);
      });
    } else {
      await this._sendFileEvent(file, forceChanged);
    }
  }

  private async _sendFileEvent(file: TAbstractFile, forceChanged: boolean): Promise<void> {
    if (!this.ws.isConnected) return;
    this.plugin.log("Sending file event:", file.path);
    const isBinary = Utils.isBinary(file.path);
    const stat = await this.plugin.app.vault.adapter.stat(file.path);
    if (!stat) return;

    const stored = this.storage.readMetadata(file.path);
    if (!forceChanged && stored && stored.mtime === stat.mtime && stored.sha1) {
      this.plugin.log("File unchanged, skipping:", file.path);
      return;
    }

    let sha1: string | null = null;
    let content = "";

    if (isBinary) {
      const buf = await this.storage.readBinary(file.path);
      if (buf) { sha1 = await Utils.getSHABinary(buf); content = Buffer.from(buf).toString("base64"); }
    } else {
      const txt = await this.storage.read(file.path);
      if (txt != null) { sha1 = await Utils.getSHA(txt); content = Buffer.from(txt).toString("base64"); }
    }

    const entry: FileEntry = {
      path: file.path,
      sha1: sha1 ?? "",
      mtime: stat.mtime,
      action: "active",
      fileType: "file",
    };

    this.ws.send({ type: "file_data", mode: "apply", file: entry, content });
    await this.storage.writeMetadata(entry);
    this.addActivity("up", file.path);
  }

  private async _processDeleteQueue(): Promise<void> {
    if (!this.ws.isConnected || this.isProcessingDeleteQueue) return;
    const paths = Object.keys(this.deleteQueue);
    if (paths.length === 0) return;
    this.isProcessingDeleteQueue = true;
    const processed: string[] = [];
    try {
      for (const path of paths) {
        const entry = this.deleteQueue[path]!;
        const current = this.plugin.app.vault.getAbstractFileByPath(path);
        const currentMeta = this.storage.readMetadata(path);
        if (current && currentMeta && (currentMeta.mtime ?? 0) > (entry.metadata.mtime ?? 0)) {
          processed.push(path); continue;
        }
        const file: FileEntry = {
          path, sha1: entry.metadata.sha1 ?? "", mtime: entry.metadata.mtime ?? Date.now(),
          action: "deleted", fileType: entry.metadata.fileType ?? "file",
        };
        this.ws.send({ type: "file_data", mode: "apply", file, content: "" });
        await this.storage.writeMetadata(file);
        processed.push(path);
      }
    } finally {
      for (const p of processed) delete this.deleteQueue[p];
      await this.storage.saveDeleteQueue(this.deleteQueue);
      this.isProcessingDeleteQueue = false;
    }
  }

  // ── Config file monitoring ────────────────────────────────────────────────

  private async _onFocusChanged(): Promise<void> {
    this.xTimeouts.executeAll();
    await this._checkConfigFiles();
  }

  private _watchedConfigFiles(): string[] {
    const s = this.plugin.settings;
    const files: string[] = [];
    if (s.syncMainSettings) { files.push(".obsidian/app.json"); }
    if (s.syncAppearanceSettings) { files.push(".obsidian/appearance.json"); }
    if (s.syncHotkeys) { files.push(".obsidian/hotkeys.json"); }
    if (s.syncActiveCorePlugins) { files.push(".obsidian/core-plugins.json", ".obsidian/core-plugins-migration.json"); }
    if (s.syncActiveCommunityPlugins) { files.push(".obsidian/community-plugins.json"); }
    return files;
  }

  private async _checkConfigFiles(): Promise<void> {
    if (!this.ws.isConnected || !this.plugin.settings.autoSync || this.isSyncing) return;
    for (const path of this._watchedConfigFiles()) {
      if (this.exclusionFilter?.isExcluded(path)) continue;
      const stat = await this.plugin.app.vault.adapter.stat(path);
      if (!stat) continue;
      await this._sendFileEvent({ path } as TAbstractFile, false);
    }
    this.xNotify.updatePendingCount(Object.keys(this.unsentSessionEvents).length);
  }

  // ── Version history / file download ──────────────────────────────────────

  private _waitForResponse<T extends ServerMsg>(type: T["type"], timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responseListeners = this.responseListeners.filter((cb) => cb !== check);
        reject(new Error(`Timeout waiting for ${type}`));
      }, timeoutMs);
      const check = (msg: ServerMsg): boolean => {
        if (msg.type !== type) return false;
        clearTimeout(timer);
        resolve(msg as T);
        return true;
      };
      this.responseListeners.push(check);
    });
  }

  async listVersionHistory(path: string): Promise<import("@ionsync/protocol").FileHistoryResponseMsg> {
    this.ws.send({ type: "file_history", path });
    return this._waitForResponse("file_history_response");
  }

  async downloadVersion(path: string): Promise<import("@ionsync/protocol").FileDataResponseMsg> {
    this.ws.send({ type: "file_data", mode: "send", path });
    return this._waitForResponse("file_data_response");
  }

  // ── Activity log ──────────────────────────────────────────────────────────

  addActivity(direction: "up" | "down" | "delete", path: string): void {
    const icon = direction === "up" ? "↑" : direction === "down" ? "↓" : "🗑";
    this.activityLog.unshift(`[${new Date().toLocaleTimeString()}] ${icon} ${path}`);
    if (this.activityLog.length > this.MAX_ACTIVITY) this.activityLog.pop();
  }

  getActivityLog(): string[] { return this.activityLog; }

  // ── Wake lock ─────────────────────────────────────────────────────────────

  private async acquireWakeLock(): Promise<void> {
    try {
      if ("wakeLock" in navigator && this.wakeLock === null) {
        this.wakeLock = await (navigator as any).wakeLock.request("screen");
        this.wakeLock?.addEventListener("release", () => { this.wakeLock = null; });
      }
    } catch { /* not available */ }
  }

  releaseWakeLock(): void {
    if (this.wakeLock !== null) { this.wakeLock.release().catch(() => {}); this.wakeLock = null; }
  }
}
