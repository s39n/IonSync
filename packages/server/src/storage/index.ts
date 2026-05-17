/**
 * Versioned file content storage.
 *
 * Layout on disk:
 *   <base>/<file-path>/v_<mtime>   — file content at that version
 *
 * The <file-path> mirrors the vault path exactly, so nested directories are
 * preserved. All paths are validated to prevent traversal outside <base>.
 */

import fs from "node:fs";
import path from "node:path";

export class Storage {
  constructor(private readonly base: string) {}

  init(): void {
    fs.mkdirSync(this.base, { recursive: true });
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  private resolve(filePath: string): string {
    // Normalise and ensure the resolved path stays inside base
    const resolved = path.resolve(this.base, filePath);
    const rel = path.relative(this.base, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    return resolved;
  }
  // ─── Size Checking ───────────────────────────────────────────────────────
  /**
   * Returns the size of the latest version of a file in bytes.
   * Returns null if no versions exist.
   */
  getSizeLatest(filePath: string): number | null {
    const versions = this.listVersionMtimes(filePath);
    if (versions.length === 0) return null;
    return this.getSizeVersion(filePath, versions[0]!);
  }

  getSizeVersion(filePath: string, mtime: number): number | null {
    const vp = this.versionPath(filePath, mtime);
    if (!fs.existsSync(vp)) return null;
    return fs.statSync(vp).size;
  }
  private versionPath(filePath: string, mtime: number): string {
    return path.join(this.resolve(filePath), `v_${mtime}`);
  }

  // ─── Write ───────────────────────────────────────────────────────────────

  write(filePath: string, mtime: number, content: Buffer): void {
    const dir = this.resolve(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.versionPath(filePath, mtime), content);
  }

  // ─── Read ────────────────────────────────────────────────────────────────

  /**
   * Reads the latest version (highest mtime) of a file.
   * Returns null if no versions exist.
   */
  readLatest(filePath: string): Buffer | null {
    const versions = this.listVersionMtimes(filePath);
    if (versions.length === 0) return null;
    // listVersionMtimes returns descending order
    return this.readVersion(filePath, versions[0]!);
  }

  readVersion(filePath: string, mtime: number): Buffer | null {
    const vp = this.versionPath(filePath, mtime);
    if (!fs.existsSync(vp)) return null;
    return fs.readFileSync(vp);
  }

  // ─── Version management ──────────────────────────────────────────────────

  /**
   * Returns all stored mtime values for a file, sorted descending (newest first).
   */
  listVersionMtimes(filePath: string): number[] {
    const dir = this.resolve(filePath);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("v_"))
      .map((name) => parseInt(name.slice(2), 10))
      .filter((n) => !isNaN(n))
      .sort((a, b) => b - a);
  }

  deleteVersion(filePath: string, mtime: number): void {
    const vp = this.versionPath(filePath, mtime);
    if (fs.existsSync(vp)) fs.unlinkSync(vp);
  }

  /**
   * Removes all content versions for a file (used when permanently purging a
   * deleted file from the system).
   */
  deleteAllVersions(filePath: string): void {
    const dir = this.resolve(filePath);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Prune old versions, keeping only the `keepCount` newest.
   * Returns the mtimes that were deleted.
   */
  pruneVersions(filePath: string, keepCount: number): number[] {
    const all = this.listVersionMtimes(filePath);
    const toDelete = all.slice(keepCount); // everything past the keepCount-th newest
    for (const mtime of toDelete) this.deleteVersion(filePath, mtime);
    return toDelete;
  }

  /**
   * Wipes all stored file content (factory reset).
   * Removes the entire base directory and recreates it empty so the server
   * can continue operating immediately after a reset.
   */
  deleteAllFiles(): void {
    if (fs.existsSync(this.base)) {
      fs.rmSync(this.base, { recursive: true, force: true });
    }
    fs.mkdirSync(this.base, { recursive: true });
  }

  /**
   * Renames a folder prefix by moving all version directories under
   * `fromPrefix/` to `toPrefix/`.  Used by the folder-rename admin action.
   * Returns the list of old→new path pairs that were moved.
   */
  renameFolder(fromPrefix: string, toPrefix: string): Array<{ oldPath: string; newPath: string }> {
    const fromDir = this.resolve(fromPrefix);
    if (!fs.existsSync(fromDir)) return [];

    const moved: Array<{ oldPath: string; newPath: string }> = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith("v_")) {
          walk(full);
        }
      }
    };

    // Collect all vault-path directories under fromDir (leaf dirs contain v_* files)
    const collectLeafDirs = (dir: string, rel: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const hasVersions = entries.some(e => e.isFile() && e.name.startsWith("v_"));
      if (hasVersions) {
        const oldVaultPath = fromPrefix + "/" + rel;
        const newVaultPath = toPrefix + "/" + rel;
        moved.push({ oldPath: oldVaultPath.replace(/^\/+/, ""), newPath: newVaultPath.replace(/^\/+/, "") });
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          collectLeafDirs(path.join(dir, e.name), rel ? rel + "/" + e.name : e.name);
        }
      }
    };

    collectLeafDirs(fromDir, "");

    // Move each leaf storage directory
    for (const { oldPath, newPath } of moved) {
      const src = this.resolve(oldPath);
      const dst = this.resolve(newPath);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
    }

    // Remove the now-empty fromDir tree
    try { fs.rmSync(fromDir, { recursive: true, force: true }); } catch { /* non-fatal */ }

    return moved;
  }
}
