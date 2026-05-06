import type { FileEntry } from "@ionsync/protocol";
import type { App } from "obsidian";
import { FSAdapter } from "./FSAdapter.js";
import Utils from "./Utils.js";
import type { PluginSettings } from "./main.js";

/**
 * Manages local file metadata and vault I/O.
 *
 * Metadata is stored as a flat JSON object at:
 *   <plugin-dir>/data/metadata.json
 *
 * Key: relative path from vault root.
 * Value: FileEntry (path, sha1, mtime, action, fileType).
 */
export class Storage {
  /** In-memory tree used during a sync pass */
  tree: Record<string, FileEntry> = {};

  private fsVault: FSAdapter;
  private fsInternal: FSAdapter;
  private metadata: Record<string, FileEntry> = {};
  private aborted = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private app: App, private settings: PluginSettings, private pluginDir: string) {
    this.fsVault = new FSAdapter(app, "");
    this.fsInternal = new FSAdapter(app, pluginDir + "/");
  }

  async init(): Promise<void> {
    await this.loadMetadata();
    await this.loadDeleteQueue();
  }

  // ── Metadata persistence ───────────────────────────────────────────────────

  private async loadMetadata(): Promise<void> {
    try {
      const raw = await this.fsInternal.read("data/metadata.json");
      if (raw) this.metadata = JSON.parse(raw) as Record<string, FileEntry>;
    } catch {
      this.metadata = {};
    }
  }

  private async saveMetadata(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.fsInternal.write("data/metadata.json", JSON.stringify(this.metadata));
  }

  private requestSave(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      void this.saveMetadata();
    }, 2_000);
  }

  readMetadata(path: string): FileEntry | null {
    return this.metadata[path] ?? null;
  }

  async writeMetadata(entry: FileEntry): Promise<void> {
    this.metadata[entry.path] = entry;
    this.requestSave();
  }

  async deleteMetadata(path: string): Promise<void> {
    delete this.metadata[path];
    this.requestSave();
  }

  /** Force immediate save of metadata */
  async flushMetadata(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.saveMetadata();
  }

  // ── Delete queue (offline-queued deletions) ────────────────────────────────

  private deleteQueueData: Record<string, { metadata: Partial<FileEntry>; timestamp: number }> = {};

  async loadDeleteQueue(): Promise<Record<string, { metadata: Partial<FileEntry>; timestamp: number }>> {
    try {
      const raw = await this.fsInternal.read("data/delete-queue.json");
      if (raw) this.deleteQueueData = JSON.parse(raw);
    } catch {
      this.deleteQueueData = {};
    }
    return this.deleteQueueData;
  }

  async saveDeleteQueue(queue: Record<string, { metadata: Partial<FileEntry>; timestamp: number }>): Promise<void> {
    this.deleteQueueData = queue;
    await this.fsInternal.write("data/delete-queue.json", JSON.stringify(queue));
  }

  // ── Plugin update (auto-update received from server) ──────────────────────

  async updatePlugin(files: { name: string; content: string }[]): Promise<void> {
    for (const f of files) {
      const data = Buffer.from(f.content, "base64").toString("utf-8");
      await this.fsInternal.write("../" + f.name, data);
    }
  }

  // ── Tree computation (full vault scan for sync) ────────────────────────────

  abortTree(): void { this.aborted = true; }

  async computeTree(): Promise<void> {
    this.aborted = false;
    this.tree = {};

    await this.fsVault.iterate(async ({ path, stat, isFolder }) => {
      if (this.aborted) return;

      // Skip the plugin's own data files
      if (path.startsWith(this.pluginDir.replace(/^\//, "") + "/data/")) return;

      if (isFolder) {
        const mtime = await this.getFolderMTime(path);
        if (mtime === null) return;
        const stored = this.readMetadata(path);
        if (stored && stored.mtime === mtime) return;
        this.tree[path] = { path, sha1: "", mtime, action: "active", fileType: "folder" };
      } else {
        if (!stat) return;
        const mtime = stat.mtime;
        const stored = this.readMetadata(path);
        if (stored && stored.mtime === mtime && stored.sha1) {
          this.tree[path] = stored;
          return;
        }
        const isBinary = Utils.isBinary(path);
        let sha1: string | null = null;
        if (isBinary) {
          const buf = await this.fsVault.readBinary(path);
          sha1 = buf ? await Utils.getSHABinary(buf) : null;
        } else {
          const txt = await this.fsVault.read(path);
          sha1 = txt != null ? await Utils.getSHA(txt) : null;
        }
        this.tree[path] = { path, sha1: sha1 ?? "", mtime, action: "active", fileType: "file" };
      }
    }, this.pluginDir.replace(/^\//, "") + "/data");
  }

  private async getFolderMTime(path: string): Promise<number | null> {
    let maxMtime = 0;
    let hasChildren = false;
    try {
      const listing = await this.app.vault.adapter.list(path);
      for (const child of [...(listing.files ?? []), ...(listing.folders ?? [])]) {
        hasChildren = true;
        const childStat = await this.app.vault.adapter.stat(child);
        if (childStat && childStat.mtime > maxMtime) maxMtime = childStat.mtime;
      }
    } catch { return null; }
    return hasChildren ? maxMtime : null;
  }

  // ── Vault I/O ─────────────────────────────────────────────────────────────

  async read(path: string): Promise<string | null> {
    return this.fsVault.read(path);
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.fsVault.readBinary(path);
  }

  /**
   * Write a text file received from the server.
   * content is a base64-encoded string.
   */
  async write(path: string, content: string, entry: FileEntry): Promise<void> {
    const text = Buffer.from(content, "base64").toString("utf-8");
    await this.fsVault.write(path, text, entry.mtime);
    await this.writeMetadata(entry);
  }

  /**
   * Write a binary file received from the server.
   * content is a base64-encoded string.
   */
  async writeBinary(path: string, content: string, entry: FileEntry): Promise<void> {
    const buf = Buffer.from(content, "base64");
    await this.fsVault.writeBinary(path, buf.buffer, entry.mtime);
    await this.writeMetadata(entry);
  }

  async makeFolder(path: string, entry: FileEntry): Promise<void> {
    await this.fsVault.makeFolder(path);
    await this.writeMetadata(entry);
  }

  /** Move to Obsidian trash (keeps metadata for deleted-file tracking) */
  async delete(path: string, entry: FileEntry): Promise<void> {
    await this.fsVault.delete(path);
    entry.action = "deleted";
    await this.writeMetadata(entry);
  }
}
