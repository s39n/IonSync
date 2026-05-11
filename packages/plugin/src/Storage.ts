import type { FileEntry } from "@ionsync/protocol";
import { TFile, TFolder, type App } from "obsidian";
import { FSAdapter } from "./FSAdapter.js";
import { ExclusionFilter } from "./ExclusionFilter.js";
import Utils from "./Utils.js";
import type { PluginSettings } from "./main.js";

/**
 * Manages local file metadata, vault I/O, Delta-Sync Shadow Copies,
 * and lightning-fast boot tree calculations.
 */
export class Storage {
  tree: Record<string, FileEntry> = {};

  private fsVault: FSAdapter;
  private fsInternal: FSAdapter;
  private metadata: Record<string, FileEntry> = {};
  private aborted = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private deleteQueueData: Record<string, { metadata: Partial<FileEntry>; timestamp: number }> = {};

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

  // ── Tree computation (Fast Boot Edition) ───────────────────────────────────

  abortTree(): void { this.aborted = true; }

  async computeTree(): Promise<void> {
    this.aborted = false;
    this.tree = {};
    const exclusionFilter = new ExclusionFilter(this.settings, this.app.vault.configDir);

    // 🚀 THE DATAVIEW SECRET: Use Obsidian's in-memory cache! Zero disk I/O.
    const files = this.app.vault.getAllLoadedFiles();

    for (const file of files) {
      if (this.aborted) break;
      if (exclusionFilter.isExcluded(file.path)) continue;
      
      // Ignore plugin's internal shadow/metadata files
      if (file.path.startsWith(this.pluginDir.replace(/^\//, "") + "/data/")) continue;

      if (file instanceof TFolder) {
        this.tree[file.path] = { path: file.path, sha1: "", mtime: 0, action: "active", fileType: "folder" };
      } 
      else if (file instanceof TFile) {
        const mtime = file.stat.mtime;
        const stored = this.readMetadata(file.path);

        // 🔥 FAST PATH: Memory mtime matches stored mtime -> Instant skip
        if (stored && stored.mtime === mtime && stored.sha1 && stored.sha1.length === 40) {
          this.tree[file.path] = stored;
          continue;
        }

        const MAX_FILE_SIZE = (this.settings.maxFileSizeMB ?? 25) * 1024 * 1024;
        if (file.stat.size > MAX_FILE_SIZE) {
          this.tree[file.path] = { path: file.path, sha1: "", mtime, action: "active", fileType: "file" };
          continue;
        }

        // 🐢 SLOW PATH: File changed offline. Read disk to hash it.
        const isBinary = Utils.isBinary(file.path);
        let sha1: string | null = null;
        if (isBinary) {
          const buf = await this.fsVault.readBinary(file.path);
          sha1 = buf ? await Utils.getSHABinary(buf) : null;
        } else {
          const txt = await this.fsVault.read(file.path);
          sha1 = txt != null ? await Utils.getSHA(txt) : null;
        }
        
        this.tree[file.path] = { path: file.path, sha1: sha1 ?? "", mtime, action: "active", fileType: "file" };
      }
    }

    // Obsidian's cache hides the .obsidian config folder, so we check them manually.
    await this._computeHiddenConfigFiles(exclusionFilter);
  }

  private async _computeHiddenConfigFiles(exclusionFilter: ExclusionFilter): Promise<void> {
    const configDir = this.app.vault.configDir;
    const targets = [
      `${configDir}/app.json`, 
      `${configDir}/appearance.json`, 
      `${configDir}/hotkeys.json`, 
      `${configDir}/community-plugins.json`
    ];

    for (const path of targets) {
      if (this.aborted) break;
      if (exclusionFilter.isExcluded(path)) continue;

      try {
        const stat = await this.app.vault.adapter.stat(path);
        if (!stat) continue;

        const mtime = stat.mtime;
        const stored = this.readMetadata(path);

        if (stored && stored.mtime === mtime && stored.sha1) {
          this.tree[path] = stored;
          continue;
        }

        const txt = await this.fsVault.read(path);
        const sha1 = txt != null ? await Utils.getSHA(txt) : "";
        this.tree[path] = { path, sha1: sha1 ?? "", mtime, action: "active", fileType: "file" };
      } catch {
        // File doesn't exist, just skip
      }
    }
  }

  // ── Vault I/O ─────────────────────────────────────────────────────────────

  // ✅ New Bulletproof Guard: Recursively creates parent folders if they are missing
  private async ensureParentDir(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    parts.pop(); // Remove the file name to get just the directory path
    let current = "";
    
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        try {
          await this.app.vault.adapter.mkdir(current);
        } catch (e) {
          // Safely ignore: Another concurrent WebSocket file push might have just created it a millisecond ago
        }
      }
    }
  }

  async read(path: string): Promise<string | null> { return this.fsVault.read(path); }

  async readBinary(path: string): Promise<ArrayBuffer | null> { return this.fsVault.readBinary(path); }

  async write(path: string, content: string, entry: FileEntry): Promise<void> {
    await this.ensureParentDir(path); // ✅ Call the guard before writing

    const text = Buffer.from(content, "base64").toString("utf-8");
    await this.fsVault.write(path, text, entry.mtime);
    await this.writeMetadata(entry);
    await this.writeShadow(path, text); 
  }

  async writeBinary(path: string, content: string, entry: FileEntry): Promise<void> {
    await this.ensureParentDir(path); // ✅ Call the guard before writing

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