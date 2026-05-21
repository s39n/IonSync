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
    await this.ensureDataDir();
    await this.loadMetadata();
    await this.loadDeleteQueue();
  }

  private async ensureDataDir(): Promise<void> {
    const dataDir = this.pluginDir + "/data";
    try {
      await this.app.vault.adapter.mkdir(dataDir);
    } catch {
      // Already exists — that's fine
    }
    // Create the shadow subdirectory here so it is guaranteed to exist before
    // any sync begins.  Creating it lazily inside writeShadow causes a race:
    // during a large initial sync many concurrent writeShadow calls all pass
    // the exists() check at the same time, then the first mkdir wins and
    // subsequent write() calls get ENOENT because the directory isn't there yet.
    const shadowDir = dataDir + "/shadow";
    try {
      await this.app.vault.adapter.mkdir(shadowDir);
    } catch {
      // Already exists — that's fine
    }
  }

  // ── Delta Sync: Shadow Storage ─────────────────────────────────────────────

  /** Converts a vault path to a safe, flat hex filename for shadow storage */
  private _getShadowPath(vaultPath: string): string {
    const encoder = new TextEncoder();
    const data = encoder.encode(vaultPath);
    const hex = Array.from(data)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `data/shadow/${hex}.md`;
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
      await this.fsInternal.write(this._getShadowPath(vaultPath), content);
    } catch (e) {
      console.error("[IonSync] Failed to write shadow copy:", e);
    }
  }

  // ── Metadata persistence ───────────────────────────────────────────────────

  private async loadMetadata(): Promise<void> {
    try {
      const raw = await this.fsInternal.read("data/metadata.json");
      if (raw) {
        try {
          this.metadata = JSON.parse(raw) as Record<string, FileEntry>;
        } catch (parseErr) {
          // Corrupted metadata file — start fresh.  Without this warning the
          // user would see a silent full re-sync with no obvious explanation.
          console.warn("[IonSync] metadata.json is corrupt, starting fresh:", parseErr);
          this.metadata = {};
        }
      }
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
    // Throttle (NOT debounce): schedule a save 2 seconds after the FIRST write
    // since the last flush.  Do NOT reset the timer on subsequent writes.
    //
    // Why this matters: during a large initial sync (e.g. 1,000+ files being
    // pushed from the server), every file download calls writeMetadata().  A
    // debounce would reset the 2-second timer on every call, meaning the save
    // only fires 2 seconds after the very last file — which may never happen if
    // the connection drops or Obsidian closes mid-sync.  A throttle fires 2
    // seconds after the download *starts*, so metadata is checkpointed every ~2s
    // regardless of how many more files are still coming.
    if (!this.saveTimeout) {
      this.saveTimeout = setTimeout(() => {
        this.saveTimeout = null;
        void this.saveMetadata();
      }, 2_000);
    }
  }

  readMetadata(path: string): FileEntry | null { return this.metadata[path] ?? null; }

  /** Returns the full in-memory metadata map. Used by sync() to include
   *  entries for files that were acknowledged but not written to disk
   *  (e.g. encrypted files on a non-E2EE device). */
  getAllMetadata(): Record<string, FileEntry> { return this.metadata; }

  /** True when this device has at least one file recorded in its sync metadata,
   *  i.e. it has completed at least one successful sync session before. */
  hasAnyMetadata(): boolean { return Object.keys(this.metadata).length > 0; }

  async writeMetadata(entry: FileEntry): Promise<void> {
    this.metadata[entry.path] = entry;
    this.requestSave();
  }

  async deleteMetadata(path: string): Promise<void> {
    delete this.metadata[path];
    this.requestSave();
  }

  /**
   * Bumps every stored file's mtime to now so that on the next sync the server
   * sees them all as client-newer and requests a fresh upload.  Used when E2EE
   * is toggled on so the server receives encrypted copies of every file.
   */
  async bumpAllMtimesForReEncrypt(): Promise<void> {
    const now = Date.now();
    for (const key of Object.keys(this.metadata)) {
      const entry = this.metadata[key];
      if (entry && entry.action === "active" && entry.fileType === "file") {
        this.metadata[key] = { ...entry, mtime: now };
      }
    }
    // Also clear the computed tree so computeTree() recomputes everything fresh
    this.tree = {};
    await this.saveMetadata();
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
      const data = atob(f.content);
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

        // If metadata was bumped for re-encryption (stored.mtime > filesystem mtime),
        // honour the bumped mtime so the server sees this file as client_newer.
        // Only apply this when stored.action === "active" — if the stored entry is
        // "deleted" (e.g. because the delete queue drained before computeTree ran),
        // using that high delete-timestamp as the mtime would make the server think
        // the client's version is newly modified and trigger incorrect comparisons.
        const effectiveMtime = stored && stored.action === "active" && stored.mtime > mtime ? stored.mtime : mtime;
        this.tree[file.path] = { path: file.path, sha1: sha1 ?? "", mtime: effectiveMtime, action: "active", fileType: "file" };
      }
    }

    // Obsidian's cache hides the .obsidian config folder, so we check them manually.
    await this._computeHiddenConfigFiles(exclusionFilter);
  }

  private async _computeHiddenConfigFiles(exclusionFilter: ExclusionFilter): Promise<void> {
    const configDir = this.app.vault.configDir;

    // Seed with files that have dedicated exclusion toggles.
    // core-plugins.json / core-plugins-migration.json added here so
    // syncActiveCorePlugins is honoured even when syncHiddenFiles is off.
    const targets: string[] = [
      `${configDir}/app.json`,
      `${configDir}/appearance.json`,
      `${configDir}/hotkeys.json`,
      `${configDir}/community-plugins.json`,
      `${configDir}/core-plugins.json`,
      `${configDir}/core-plugins-migration.json`,
    ];

    // Core plugin settings: any remaining JSON files directly in .obsidian/
    // (e.g. daily-notes.json, templates.json). Not subdirectories.
    try {
      const listing = await this.app.vault.adapter.list(configDir);
      for (const f of listing.files) {
        if (f.endsWith(".json") && !targets.includes(f)) targets.push(f);
      }
    } catch { /* configDir unreadable — skip */ }

    // Installed community plugins — .obsidian/plugins/ (recursive).
    // The exclusion filter gates on syncInstalledCommunityPlugins and always
    // strips the ion-sync directory, so we enumerate unconditionally here.
    await this._enumerateConfigDir(`${configDir}/plugins`, targets);

    // Themes and CSS snippets
    await this._enumerateConfigDir(`${configDir}/themes`, targets);
    await this._enumerateConfigDir(`${configDir}/snippets`, targets);

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
        const effectiveMtime = stored && stored.action === "active" && stored.mtime > mtime ? stored.mtime : mtime;
        this.tree[path] = { path, sha1: sha1 ?? "", mtime: effectiveMtime, action: "active", fileType: "file" };
      } catch {
        // File doesn't exist or can't be read — skip silently
      }
    }
  }

  /** Recursively lists all files under `dir` and appends their vault-relative paths to `out`. */
  private async _enumerateConfigDir(dir: string, out: string[]): Promise<void> {
    try {
      const listing = await this.app.vault.adapter.list(dir);
      for (const f of listing.files) out.push(f);
      for (const sub of listing.folders) await this._enumerateConfigDir(sub, out);
    } catch { /* directory doesn't exist or is unreadable — skip silently */ }
  }

  // ── Vault I/O ─────────────────────────────────────────────────────────────

  // Recursively creates parent folders if they are missing.
  private async ensureParentDir(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    parts.pop(); // strip filename, keep only the directory components
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      // vault.getAbstractFileByPath checks Obsidian's in-memory vault index
      // (always accurate on Android).  vault.createFolder goes through
      // Obsidian's vault layer which handles Android storage correctly, unlike
      // vault.adapter.mkdir which silently fails in some Android environments.
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); } catch { /* already exists */ }
      }
    }
  }

  async read(path: string): Promise<string | null> { return this.fsVault.read(path); }

  async readBinary(path: string): Promise<ArrayBuffer | null> { return this.fsVault.readBinary(path); }

  async write(path: string, content: string, entry: FileEntry): Promise<void> {
    await this.ensureParentDir(path); // ✅ Call the guard before writing

    const text = new TextDecoder("utf-8").decode(Utils.fromBase64(content));
    await this.fsVault.write(path, text, entry.mtime);

    // Stat the file after writing to capture the mtime the OS actually assigned.
    // vault.adapter.write() does not honour the mtime argument — it always stamps
    // the file with the current clock.  If we store the server's mtime instead,
    // _checkConfigFiles and _sendFileEvent see stored.mtime ≠ stat.mtime every 5 s
    // and re-upload the file indefinitely, causing a cross-device ping-pong loop.
    const stat = await this.app.vault.adapter.stat(path);
    const metaEntry = stat ? { ...entry, mtime: stat.mtime } : entry;
    await this.writeMetadata(metaEntry);
    await this.writeShadow(path, text);
  }

  async writeBinary(path: string, content: string, entry: FileEntry): Promise<void> {
    await this.ensureParentDir(path);

    const binaryString = atob(content);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    await this.fsVault.writeBinary(path, bytes.buffer, entry.mtime);

    // Same mtime fix as write() above — store the OS-assigned mtime, not the
    // server's, so the fast-path check in _sendFileEvent stays stable.
    const stat = await this.app.vault.adapter.stat(path);
    const metaEntry = stat ? { ...entry, mtime: stat.mtime } : entry;
    await this.writeMetadata(metaEntry);
  }

  async delete(path: string, entry: FileEntry): Promise<void> {
    await this.fsVault.delete(path);
    await this.deleteMetadata(path);
  }

  async makeFolder(path: string, entry: FileEntry): Promise<void> {
    await this.fsVault.makeFolder(path);
    await this.writeMetadata(entry);
  }
}