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

  /**
   * Opens a lazy read stream over a stored version. Used by the ZIP export
   * endpoints so the archiver pulls content file-by-file instead of the route
   * buffering every file up front (which could hold tens of thousands of
   * Buffers in memory on a large-vault export).
   */
  openVersionStream(filePath: string, mtime: number): fs.ReadStream | null {
    const vp = this.versionPath(filePath, mtime);
    if (!fs.existsSync(vp)) return null;
    return fs.createReadStream(vp);
  }

  /**
   * Reads only the first `length` bytes of a stored version — enough to check
   * the E2EE magic header without loading the whole file.
   */
  readVersionPrefix(filePath: string, mtime: number, length: number): Buffer | null {
    const vp = this.versionPath(filePath, mtime);
    if (!fs.existsSync(vp)) return null;
    const fd = fs.openSync(vp, "r");
    try {
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, 0);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** The mtime of the newest stored version, or null when none exist. */
  latestVersionMtime(filePath: string): number | null {
    const versions = this.listVersionMtimes(filePath);
    return versions.length > 0 ? versions[0]! : null;
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
   * Scans every stored version file and removes any that are 0 bytes (corrupt /
   * interrupted uploads).  Returns the list of removed entries so the caller
   * can also delete the corresponding file_versions rows from the DB.
   */
  pruneCorruptVersions(): Array<{ filePath: string; mtime: number }> {
    const removed: Array<{ filePath: string; mtime: number }> = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.startsWith("v_")) {
          const size = fs.statSync(full).size;
          if (size === 0) {
            const mtime = parseInt(entry.name.slice(2), 10);
            if (!isNaN(mtime)) {
              fs.unlinkSync(full);
              // Convert the on-disk directory path back to a vault path
              const dir2 = path.dirname(full);
              const vaultPath = path.relative(this.base, dir2).split(path.sep).join("/");
              removed.push({ filePath: vaultPath, mtime });
            }
          }
        }
      }
    };
    walk(this.base);
    return removed;
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
   * Renames a single file's storage directory from `fromPath` to `toPath`.
   * If a directory already exists at `toPath`, it is removed first so the
   * rename is effectively an overwrite.  Used by the conflict-promotion action.
   */
  renameFile(fromPath: string, toPath: string): void {
    const fromDir = this.resolve(fromPath);
    if (!fs.existsSync(fromDir)) return;
    const toDir = this.resolve(toPath);
    // Remove any existing destination so renameSync doesn't fail on non-empty dirs
    if (fs.existsSync(toDir)) {
      fs.rmSync(toDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(toDir), { recursive: true });
    fs.renameSync(fromDir, toDir);
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
