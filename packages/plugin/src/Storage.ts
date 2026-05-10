import type { FileEntry } from "@ionsync/protocol";
import type { App } from "obsidian";
import { FSAdapter } from "./FSAdapter.js";
import { ExclusionFilter } from "./ExclusionFilter.js";
import Utils from "./Utils.js";
import type { PluginSettings } from "./main.js";

/**
 * Manages local file metadata, vault I/O, and Delta-Sync Shadow Copies.
 */
export class Storage {
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

  // ── Delta Sync: Shadow Storage ─────────────────────────────────────────────

  /** Converts a vault path to a safe, flat hex filename for shadow storage */
  private _getShadowPath(vaultPath: string): string {
    const safeName = Buffer.from(vaultPath).toString("hex");
    return `data/shadow/${safeName}.md`;
  }

  async readShadow(vaultPath: string): Promise<string | null> {
    try {
      return await this.fsInternal.read(this._getShadowPath(vaultPath));
    } catch {
      return null; // Shadow doesn't exist yet
    }
  }

  async writeShadow(vaultPath: string, content: string): Promise<void> {
    try {
      const shadowDir = this.pluginDir + "/data/shadow";
      if (!(await this.app.vault.adapter.exists(shadowDir))) {
        await this.app.vault.adapter.mkdir(shadowDir);
      }
      await this.fsInternal.write(this._getShadowPath(vaultPath), content);
    } catch (e) {
      console.error("[IonSync] Failed to write shadow copy:", e);
    }
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
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => { void this.saveMetadata(); }, 10_000); 
  }

  readMetadata(path: string): FileEntry | null { return this.metadata[path] ?? null; }

  async writeMetadata(entry: FileEntry): Promise<void> {
    this.metadata[entry.path] = entry;
    this.requestSave();
  }

  async deleteMetadata(path: string): Promise<void> {
    delete this.metadata[path];
    this.requestSave();
  }

  async flushMetadata(): Promise<void> {
    if (this.saveTimeout) { clearTimeout(this.saveTimeout); this.saveTimeout = null; }
    await this.saveMetadata();
  }

  // ── Delete queue ───────────────────────────────────────────────────────────

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

  // ── Plugin update ──────────────────────────────────────────────────────────

  async updatePlugin(files: { name: string; content: string }[]): Promise<void> {
    for (const f of files) {
      const data = Buffer.from(f.content, "base64").toString("utf-8");
      await this.fsInternal.write("../" + f.name, data);
    }
  }

  // ── Tree computation ───────────────────────────────────────────────────────

  abortTree(): void { this.aborted = true; }

  async computeTree(): Promise<void> {
    this.aborted = false;
    this.tree = {};
    const exclusionFilter = new ExclusionFilter(this.settings, this.app.vault.configDir);

    await this.fsVault.iterate(async ({ path, stat, isFolder }) => {
      if (this.aborted || exclusionFilter.isExcluded(path)) return;
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
        if (stored && stored.mtime === mtime && stored.sha1 && stored.sha1.length === 40) {
          this.tree[path] = stored;
          return;
        }

        const MAX_FILE_SIZE = 40 * 1024 * 1024; // 40MB limit
        if (stat.size > MAX_FILE_SIZE) {
          this.tree[path] = { path, sha1: "", mtime, action: "active", fileType: "file" };
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
    try {
      const stat = await this.app.vault.adapter.stat(path);
      return stat ? stat.mtime : 0;
    } catch { 
      return null; 
    }
  } 

  // ── Vault I/O ─────────────────────────────────────────────────────────────

  async read(path: string): Promise<string | null> { return this.fsVault.read(path); }

  async readBinary(path: string): Promise<ArrayBuffer | null> { return this.fsVault.readBinary(path); }

  async write(path: string, content: string, entry: FileEntry): Promise<void> {
    const text = Buffer.from(content, "base64").toString("utf-8");
    await this.fsVault.write(path, text, entry.mtime);
    await this.writeMetadata(entry);
    // ✅ Keep shadow copy perfectly synchronized with server pushes
    await this.writeShadow(path, text); 
  }

  async writeBinary(path: string, content: string, entry: FileEntry): Promise<void> {
    const buf = Buffer.from(content, "base64");
    await this.fsVault.writeBinary(path, buf.buffer, entry.mtime);
    await this.writeMetadata(entry);
  }

  async makeFolder(path: string, entry: FileEntry): Promise<void> {
    await this.fsVault.makeFolder(path);
    await this.writeMetadata(entry);
  }

  async delete(path: string, entry: FileEntry): Promise<void> {
    await this.fsVault.delete(path);
    entry.action = "deleted";
    await this.writeMetadata(entry);
  }
}