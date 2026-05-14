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

  // ─── Files ──────────────────────────────────────────────────────────────

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

  // ─── Version history ────────────────────────────────────────────────────

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

  // ─── Devices ────────────────────────────────────────────────────────────

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

  // ─── Cleanup helpers ────────────────────────────────────────────────────

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

  // Factory reset

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

  close(): void {
    this.db.close();
  }
}
