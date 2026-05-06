import { normalizePath, type App } from "obsidian";

/**
 * Low-level vault file-system wrapper.
 * basePath is either "" (vault root) or a prefix like ".obsidian/plugins/ion-sync/".
 */
export class FSAdapter {
  constructor(private app: App, private basePath: string) {}

  private norm(path: string): string {
    return normalizePath(this.basePath + path);
  }

  async makeFolder(path: string): Promise<void> {
    const full = this.norm(path);
    if (!full || full === ".") return;
    const parts = full.split("/");
    let cur = "";
    for (const part of parts) {
      if (!part) continue;
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(cur))) {
        try { await this.app.vault.adapter.mkdir(cur); } catch { /* already exists race */ }
      }
    }
  }

  async write(path: string, data: string, mtime?: number): Promise<void> {
    const p = this.norm(path);
    await this._ensureParent(path);
    const opts = mtime ? { mtime } : undefined;
    await this.app.vault.adapter.write(p, data, opts);
  }

  async writeBinary(path: string, data: ArrayBuffer, mtime?: number): Promise<void> {
    const p = this.norm(path);
    await this._ensureParent(path);
    const opts = mtime ? { mtime } : undefined;
    await this.app.vault.adapter.writeBinary(p, data, opts);
  }

  async read(path: string): Promise<string | null> {
    try { return await this.app.vault.adapter.read(this.norm(path)); }
    catch { return null; }
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    try { return await this.app.vault.adapter.readBinary(this.norm(path)); }
    catch { return null; }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(this.norm(path));
  }

  async stat(path: string): Promise<{ mtime: number; ctime: number; size: number } | null> {
    try { return await this.app.vault.adapter.stat(this.norm(path)); }
    catch { return null; }
  }

  async delete(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.norm(path));
    if (file) await this.app.fileManager.trashFile(file);
  }

  async forceDelete(path: string): Promise<void> {
    await this.app.vault.adapter.remove(this.norm(path));
  }

  /** Walk all files and folders under this adapter's base path */
  async iterate(
    callback: (item: { path: string; stat: { mtime: number; ctime: number; size: number } | null; isFolder: boolean }) => Promise<void>,
    skipPrefix?: string
  ): Promise<void> {
    const startDir = normalizePath(this.basePath) || "/";
    await this._iterateDir(startDir, callback, skipPrefix);
  }

  private async _iterateDir(
    dir: string,
    callback: (item: { path: string; stat: { mtime: number; ctime: number; size: number } | null; isFolder: boolean }) => Promise<void>,
    skipPrefix?: string
  ): Promise<void> {
    let listing: { files: string[]; folders: string[] };
    try { listing = await this.app.vault.adapter.list(normalizePath(dir)); }
    catch { return; }

    const baseNorm = normalizePath(this.basePath);

    const toRelative = (abs: string): string => {
      const n = normalizePath(abs);
      if (baseNorm && n.startsWith(baseNorm)) return n.slice(baseNorm.length).replace(/^\//, "");
      return n;
    };

    for (const folderPath of listing.folders ?? []) {
      const rel = toRelative(folderPath);
      if (skipPrefix && (rel === skipPrefix || rel.startsWith(skipPrefix + "/"))) continue;
      const stat = await this.app.vault.adapter.stat(normalizePath(folderPath));
      await callback({ path: rel || "/", stat: stat ?? null, isFolder: true });
      await this._iterateDir(folderPath, callback, skipPrefix);
    }

    for (const filePath of listing.files ?? []) {
      const rel = toRelative(filePath);
      if (skipPrefix && rel.startsWith(skipPrefix + "/")) continue;
      const stat = await this.app.vault.adapter.stat(normalizePath(filePath));
      await callback({ path: rel, stat: stat ?? null, isFolder: false });
    }
  }

  private async _ensureParent(path: string): Promise<void> {
    const parts = path.split("/");
    if (parts.length > 1) {
      await this.makeFolder(parts.slice(0, -1).join("/"));
    }
  }
}
