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
}
