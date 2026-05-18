import Database from "better-sqlite3";
import type { FileEntry, VersionEntry } from "@ionsync/protocol";
import { runMigrations } from "./migrations.js";
import fs from "node:fs";
import path from "node:path";

interface DbFileRow {
  path: string;
  sha1: string;
  mtime: number;
  received_at: number;
  action: string;
  file_type: string;
}

interface DbVersionRow {
  sha1: string;
  mtime: number;
  received_at: number;
}

interface DbDeviceRow {
  id: string;
  last_online: number;
}

function rowToFileEntry(row: DbFileRow): FileEntry {
  return {
    path: row.path,
    sha1: row.sha1,
    mtime: row.mtime,
    action: row.action as FileEntry["action"],
    fileType: row.file_type as FileEntry["fileType"],
  };
}

export class SyncDB {
  private db: Database.Database;

  constructor(dbDir: string) {
    fs.mkdirSync(dbDir, { recursive: true });
    this.db = new Database(path.join(dbDir, "sync.db"));
    this.db.pragma("journal_mode = WAL");
    // NORMAL durability is safe under WAL: a crash can lose at most the last
    // committed transaction (which the plugin will re-upload on next sync).
    // The default FULL mode does an extra fsync per write that shows up as
    // noticeable latency during bulk syncs with many small files.
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    runMigrations(this.db);
  }

  // --- Files ----------------------------------------------------------------

  getFile(filePath: string): FileEntry | undefined {
    const row = this.db
      .prepare<[string], DbFileRow>("SELECT * FROM files WHERE path = ?")
      .get(filePath);
    return row ? rowToFileEntry(row) : undefined;
  }

  getAllFiles(): FileEntry[] {
    return this.db
      .prepare<[], DbFileRow>("SELECT * FROM files")
      .all()
      .map(rowToFileEntry);
  }

  upsertFile(file: FileEntry): void {
    const now = Date.now();
    this.db
      .prepare<[string, string, number, number, string, string]>(
        `INSERT INTO files (path, sha1, mtime, received_at, action, file_type)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           sha1        = excluded.sha1,
           mtime       = excluded.mtime,
           received_at = excluded.received_at,
           action      = excluded.action,
           file_type   = excluded.file_type`
      )
      .run(file.path, file.sha1, file.mtime, now, file.action, file.fileType);

    if (file.fileType === "file") {
      this.db
        .prepare<[string, string, number, number]>(
          `INSERT INTO file_versions (path, sha1, mtime, received_at) VALUES (?, ?, ?, ?)`
        )
        .run(file.path, file.sha1, file.mtime, now);
    }
  }

  deleteFileMeta(filePath: string): void {
    this.db.prepare<[string]>("DELETE FROM files WHERE path = ?").run(filePath);
    this.db.prepare<[string]>("DELETE FROM file_versions WHERE path = ?").run(filePath);
  }

  /** Update only the mtime of a file record — does NOT create a new version row. */
  updateFileMeta(filePath: string, mtime: number): void {
    this.db
      .prepare<[number, string]>("UPDATE files SET mtime = ? WHERE path = ?")
      .run(mtime, filePath);
  }


  /**
   * Updates sha1 AND mtime on the files row without creating a new version
   * entry.  Used after pruning a corrupt version to repoint the current
   * record to the latest good version.
   */
  repointFileRecord(filePath: string, sha1: string, mtime: number): void {
    this.db
      .prepare<[string, number, string]>(
        "UPDATE files SET sha1 = ?, mtime = ? WHERE path = ?"
      )
      .run(sha1, mtime, filePath);
  }

  // --- Version history ------------------------------------------------------

  getVersions(filePath: string): VersionEntry[] {
    return this.db
      .prepare<[string], DbVersionRow>(
        "SELECT sha1, mtime, received_at FROM file_versions WHERE path = ? ORDER BY mtime DESC"
      )
      .all(filePath)
      .map((r) => ({ sha1: r.sha1, mtime: r.mtime, receivedAt: r.received_at }));
  }

  getVersionsToTrim(filePath: string, keepCount: number): VersionEntry[] {
    return this.db
      .prepare<[string, number], DbVersionRow>(
        `SELECT sha1, mtime, received_at FROM file_versions
         WHERE path = ?
         ORDER BY mtime DESC
         LIMIT -1 OFFSET ?`
      )
      .all(filePath, keepCount)
      .map((r) => ({ sha1: r.sha1, mtime: r.mtime, receivedAt: r.received_at }));
  }

  pruneVersions(filePath: string, keepCount: number): void {
    this.db
      .prepare<[string, string, number]>(
        `DELETE FROM file_versions
         WHERE path = ? AND id NOT IN (
           SELECT id FROM file_versions WHERE path = ? ORDER BY mtime DESC LIMIT ?
         )`
      )
      .run(filePath, filePath, keepCount);
  }

  /**
   * Returns a map of path → received_at for every file currently flagged as
   * "deleted".  Used by the sync handler to correctly resolve the re-add case:
   * if a client sends a file as "active" with mtime > received_at, the client
   * re-added the file after the deletion was recorded and should win.
   */
  getDeletedReceivedAt(): Map<string, number> {
    const rows = this.db
      .prepare<[], { path: string; received_at: number }>(
        "SELECT path, received_at FROM files WHERE action = 'deleted'"
      )
      .all();
    return new Map(rows.map((r) => [r.path, r.received_at]));
  }

  /**
   * Physically removes deleted file record(s) from the database.
   * Unlike upsertFile({action:"deleted"}), this erases the row entirely so the
   * server treats the path as never seen — allowing the client to re-upload it
   * as a brand-new file.
   *
   * @param filePath  If provided, purges only that path. Otherwise purges all
   *                  rows with action = "deleted".
   * @returns Number of rows removed.
   */
  purgeDeletedFiles(filePath?: string): number {
    if (filePath) {
      const r = this.db
        .prepare<[string]>("DELETE FROM files WHERE path = ? AND action = 'deleted'")
        .run(filePath);
      this.db
        .prepare<[string]>("DELETE FROM file_versions WHERE path = ?")
        .run(filePath);
      return r.changes;
    }
    const r = this.db
      .prepare("DELETE FROM files WHERE action = 'deleted'")
      .run();
    return r.changes;
  }

  // --- Devices --------------------------------------------------------------

  touchDevice(id: string): void {
    this.db
      .prepare<[string, number]>(
        `INSERT INTO devices (id, last_online) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET last_online = excluded.last_online`
      )
      .run(id, Date.now());
  }

  getDevices(): Array<{ id: string; lastOnline: number }> {
    return this.db
      .prepare<[], DbDeviceRow>("SELECT * FROM devices ORDER BY last_online DESC")
      .all()
      .map((r) => ({ id: r.id, lastOnline: r.last_online }));
  }

  getOldestDeviceOnline(): number {
    const row = this.db
      .prepare<[], { min_lo: number | null }>("SELECT MIN(last_online) AS min_lo FROM devices")
      .get();
    return row?.min_lo ?? 0;
  }

  // --- Cleanup helpers ------------------------------------------------------

  getExpiredDeletedFiles(cutoff: number): FileEntry[] {
    return this.db
      .prepare<[number], DbFileRow>(
        "SELECT * FROM files WHERE action = 'deleted' AND received_at <= ?"
      )
      .all(cutoff)
      .map(rowToFileEntry);
  }

  getAllFilePaths(): string[] {
    return this.db
      .prepare<[], { path: string }>("SELECT path FROM files WHERE file_type = 'file'")
      .all()
      .map((r) => r.path);
  }

  /**
   * Returns one version entry per active file — the newest version whose mtime
   * is <= asOfMs.  Used by the snapshot-export endpoint to reconstruct the
   * vault as it existed at a specific point in time.
   */
  getSnapshotFiles(asOfMs: number): Array<{ path: string; mtime: number }> {
    return this.db
      .prepare<[number], { path: string; mtime: number }>(
        `SELECT path, MAX(mtime) AS mtime
         FROM file_versions
         WHERE mtime <= ?
         GROUP BY path`
      )
      .all(asOfMs);
  }

  // --- Factory reset --------------------------------------------------------

  /**
   * Wipes all data from the database: file versions, file metadata, and
   * device records. The schema itself is preserved so the server can
   * continue operating immediately after a reset.
   */
  resetAll(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM file_versions").run();
      this.db.prepare("DELETE FROM files").run();
      this.db.prepare("DELETE FROM devices").run();
    })();
  }

  /**
   * Marks all files with action = "deleted" back to action = "active".
   * Returns the number of files restored.
   */
  restoreDeletedFiles(): number {
    const result = this.db
      .prepare("UPDATE files SET action = 'active' WHERE action = 'deleted'")
      .run();
    return result.changes;
  }

  // --- Database manager helpers ---------------------------------------------

  getStats(): { activeFiles: number; deletedFiles: number; totalVersions: number; deviceCount: number } {
    const row = this.db.prepare<[], { active: number; deleted: number }>(`
      SELECT
        COUNT(CASE WHEN action = 'active' AND file_type = 'file' THEN 1 END) AS active,
        COUNT(CASE WHEN action = 'deleted' THEN 1 END) AS deleted
      FROM files
    `).get()!;
    const versions = (this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM file_versions").get()!).n;
    const devices  = (this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM devices").get()!).n;
    return { activeFiles: row.active, deletedFiles: row.deleted, totalVersions: versions, deviceCount: devices };
  }

  getFilesByAction(action: "active" | "deleted" | "all"): FileEntry[] {
    if (action === "all") {
      return this.db
        .prepare<[], DbFileRow>("SELECT * FROM files WHERE file_type = 'file' ORDER BY path")
        .all()
        .map(rowToFileEntry);
    }
    return this.db
      .prepare<[string], DbFileRow>("SELECT * FROM files WHERE action = ? AND file_type = 'file' ORDER BY path")
      .all(action)
      .map(rowToFileEntry);
  }

  restoreFile(filePath: string): boolean {
    const result = this.db
      .prepare<[string]>("UPDATE files SET action = 'active' WHERE path = ? AND action = 'deleted'")
      .run(filePath);
    return result.changes > 0;
  }

  deleteVersionRecord(filePath: string, mtime: number): void {
    this.db
      .prepare<[string, number]>("DELETE FROM file_versions WHERE path = ? AND mtime = ?")
      .run(filePath, mtime);
  }

  deleteDevice(id: string): void {
    this.db.prepare<[string]>("DELETE FROM devices WHERE id = ?").run(id);
  }

  // --- Settings (key-value store) -------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db
      .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
      .get(key);
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare<[string, string]>(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare<[string]>("DELETE FROM settings WHERE key = ?").run(key);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Renames all file records whose path starts with `fromPrefix/` so they
   * start with `toPrefix/` instead.  Updates both `files` and `file_versions`.
   * Returns the number of rows updated.
   */
  renameFolderPaths(fromPrefix: string, toPrefix: string): number {
    const like = fromPrefix.replace(/[%_]/g, "\$&") + "/%";
    const prefixLen = fromPrefix.length;
    const result = this.db.transaction(() => {
      const files = this.db
        .prepare<[string]>("SELECT path FROM files WHERE path LIKE ? ESCAPE '\\'")
        .all(like) as Array<{ path: string }>;
      for (const { path: oldPath } of files) {
        const newPath = toPrefix + oldPath.slice(prefixLen);
        this.db.prepare<[string, string]>("UPDATE files SET path = ? WHERE path = ?").run(newPath, oldPath);
        this.db.prepare<[string, string]>("UPDATE file_versions SET path = ? WHERE path = ?").run(newPath, oldPath);
      }
      return files.length;
    })();
    return result as number;
  }
}
