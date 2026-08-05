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
  seq: number;
  /** Set only on a tombstone created by a rename — the path the file moved to. */
  renamed_to?: string | null;
  /** Content size in bytes of the head version; -1 = unknown (pre-v5 row). */
  size: number;
}

/** A file row plus the sequence number at which its head last changed. */
export type FileChange = FileEntry & { seq: number };

/** A file row plus its stored head-content size (-1 = unknown, pre-v5 row). */
export type FileWithSize = FileEntry & { size: number };

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
    this.repairSeqCounter();
  }

  /**
   * Raise the monotonic `sync_seq` counter to at least `n`. Never lowers it.
   * Used both to realign after a restore (n = MAX(seq)) and at runtime when a
   * client's cursor proves the counter rolled back below a value we already
   * issued (n = the client's watermark). Keeping the counter monotonic is what
   * stops re-issued seqs from colliding with rows a client already has.
   */
  bumpSeqTo(n: number): void {
    if (!Number.isFinite(n)) return;
    const floor = Math.floor(n);
    if (floor > this.getCurrentSeq()) {
      this.db
        .prepare<[string]>(
          "INSERT INTO settings (key, value) VALUES ('sync_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(String(floor));
    }
  }

  /**
   * Realign `sync_seq` to `MAX(seq)` after a DB restore/rebuild that left the
   * counter behind the rows. A behind counter makes `allocateSeq` re-issue seqs
   * already on rows and makes healthy clients look "ahead of the server". Runtime
   * client-watermark rollbacks are handled in the cursor handler. (Audit §3.5.)
   */
  repairSeqCounter(): void {
    const max = this.db
      .prepare<[], { m: number }>("SELECT COALESCE(MAX(seq), 0) AS m FROM files")
      .get()!.m;
    this.bumpSeqTo(max);
  }

  // --- Sequence cursor (sync redesign phase 0) ------------------------------

  /**
   * Allocates the next value of the monotonic sync sequence counter.
   *
   * The counter is persisted in `settings` (key `sync_seq`) so it never goes
   * backwards even when rows are hard-deleted by `purgeDeletedFiles`. Call this
   * inside the same transaction as the row write that stamps the returned seq.
   */
  private allocateSeq(): number {
    const row = this.db
      .prepare<[], { value: string }>(
        "UPDATE settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'sync_seq' RETURNING value"
      )
      .get();
    if (row) return Number(row.value);

    // Counter row missing (legacy DB created before migration v3 seeded it).
    // Seed it to MAX(seq)+1 so we never reissue a value already on a row.
    const max = this.db
      .prepare<[], { m: number }>("SELECT COALESCE(MAX(seq), 0) AS m FROM files")
      .get()!.m;
    const next = max + 1;
    this.db
      .prepare<[string, string]>(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run("sync_seq", String(next));
    return next;
  }

  /** The current value of the monotonic sync sequence counter. */
  getCurrentSeq(): number {
    const row = this.db
      .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'sync_seq'")
      .get();
    return row ? Number(row.value) : 0;
  }

  /**
   * Returns file rows whose head changed after `sinceSeq`, oldest-first and
   * capped at `limit`. The basis of cursor-based delta sync: a client passes the
   * highest seq it has seen and receives only what changed since.
   */
  getChangesSince(sinceSeq: number, limit: number, includeDeletes = true): FileChange[] {
    // When includeDeletes is false, tombstones are filtered in SQL so the LIMIT
    // (and therefore the caller's `more` detection) counts only active rows. The
    // cursor still advances past the skipped tombstones — a from-0 bootstrap ends
    // caught up to the server counter and never re-fetches them.
    const sql = includeDeletes
      ? "SELECT * FROM files WHERE seq > ? ORDER BY seq ASC LIMIT ?"
      : "SELECT * FROM files WHERE seq > ? AND action = 'active' ORDER BY seq ASC LIMIT ?";
    return this.db
      .prepare<[number, number], DbFileRow>(sql)
      .all(sinceSeq, limit)
      .map((r) => ({ ...rowToFileEntry(r), seq: r.seq }));
  }

  /** The seq currently stamped on a path's row, or 0 if the path is unknown. */
  getFileSeq(filePath: string): number {
    const row = this.db
      .prepare<[string], { seq: number }>("SELECT seq FROM files WHERE path = ?")
      .get(filePath);
    return row?.seq ?? 0;
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

  /**
   * @param size Content size in bytes of the version being recorded. Pass it
   *   whenever the caller has the bytes in hand (uploads, conflict copies) so
   *   dashboard size queries never have to stat the disk. Omitted → the
   *   previously stored size is kept (metadata-only updates, deletions).
   */
  upsertFile(file: FileEntry, size?: number): void {
    const now = Date.now();
    this.db.transaction(() => {
      const seq = this.allocateSeq();
      this.db
        .prepare<[string, string, number, number, string, string, number, number]>(
          `INSERT INTO files (path, sha1, mtime, received_at, action, file_type, seq, size)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             sha1        = excluded.sha1,
             mtime       = excluded.mtime,
             received_at = excluded.received_at,
             action      = excluded.action,
             file_type   = excluded.file_type,
             seq         = excluded.seq,
             size        = CASE WHEN excluded.size >= 0 THEN excluded.size ELSE files.size END`
        )
        .run(file.path, file.sha1, file.mtime, now, file.action, file.fileType, seq, size ?? -1);

      if (file.fileType === "file") {
        this.db
          .prepare<[string, string, number, number]>(
            `INSERT INTO file_versions (path, sha1, mtime, received_at) VALUES (?, ?, ?, ?)`
          )
          .run(file.path, file.sha1, file.mtime, now);
      }
    })();
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
    this.db.transaction(() => {
      const seq = this.allocateSeq();
      this.db
        .prepare<[string, number, number, string]>(
          "UPDATE files SET sha1 = ?, mtime = ?, seq = ? WHERE path = ?"
        )
        .run(sha1, mtime, seq, filePath);
    })();
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

  /**
   * True if the given sha1 appears anywhere in the version history of a path.
   * Used by the upload conflict gate: a client whose baseSha1 is a *known but
   * non-head* version edited a stale base — a genuine concurrent edit.
   */
  hasVersionSha(filePath: string, sha1: string): boolean {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        "SELECT 1 AS n FROM file_versions WHERE path = ? AND sha1 = ? LIMIT 1"
      )
      .get(filePath, sha1);
    return row !== undefined;
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

  getDeviceName(id: string): string | null {
    return this.getSetting(`device_name_${id}`);
  }

  setDeviceName(id: string, name: string): void {
    this.setSetting(`device_name_${id}`, name.trim());
  }

  deleteDeviceName(id: string): void {
    this.deleteSetting(`device_name_${id}`);
  }

  getAllDeviceNames(): Record<string, string> {
    const rows = this.db
      .prepare<[], { key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'device_name_%'")
      .all();
    const names: Record<string, string> = {};
    for (const r of rows) {
      names[r.key.slice("device_name_".length)] = r.value;
    }
    return names;
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
    return this.db.transaction(() => {
      const rows = this.db
        .prepare<[], { path: string }>("SELECT path FROM files WHERE action = 'deleted'")
        .all();
      for (const { path: p } of rows) {
        const seq = this.allocateSeq();
        this.db
          .prepare<[number, string]>("UPDATE files SET action = 'active', seq = ? WHERE path = ?")
          .run(seq, p);
      }
      return rows.length;
    })();
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

  /**
   * File rows including the stored head-content size. Rows written before
   * migration v5 carry size = -1; callers should fall back to a storage stat
   * for those (they heal to a real size on the next upload).
   */
  getFilesWithSize(action: "active" | "deleted" | "all"): FileWithSize[] {
    const rows =
      action === "all"
        ? this.db
            .prepare<[], DbFileRow>("SELECT * FROM files WHERE file_type = 'file' ORDER BY path")
            .all()
        : this.db
            .prepare<[string], DbFileRow>(
              "SELECT * FROM files WHERE action = ? AND file_type = 'file' ORDER BY path"
            )
            .all(action);
    return rows.map((r) => ({ ...rowToFileEntry(r), size: r.size ?? -1 }));
  }

  /**
   * Total bytes of active file heads with a known size, plus the paths whose
   * size is unknown (pre-v5 rows) so the caller can stat just those.
   */
  getActiveSizeSummary(): { knownBytes: number; unknownPaths: string[] } {
    const known = this.db
      .prepare<[], { total: number | null }>(
        "SELECT SUM(size) AS total FROM files WHERE action = 'active' AND file_type = 'file' AND size >= 0"
      )
      .get();
    const unknown = this.db
      .prepare<[], { path: string }>(
        "SELECT path FROM files WHERE action = 'active' AND file_type = 'file' AND size < 0"
      )
      .all();
    return { knownBytes: known?.total ?? 0, unknownPaths: unknown.map((r) => r.path) };
  }

  restoreFile(filePath: string): boolean {
    return this.db.transaction(() => {
      const seq = this.allocateSeq();
      const result = this.db
        .prepare<[number, string]>(
          "UPDATE files SET action = 'active', seq = ? WHERE path = ? AND action = 'deleted'"
        )
        .run(seq, filePath);
      return result.changes > 0;
    })();
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
   * Renames a single file record from `fromPath` to `toPath`.
   *
   * The destination becomes active (with the renamed content and a fresh seq),
   * version history moves to the new path, and the OLD path is left as a
   * `deleted` tombstone with its own fresh seq. The tombstone is essential for
   * cursor-based delta sync: without it the changes feed has no row at the old
   * path, so a reconnecting client never learns the old path is gone and keeps
   * a stale copy.
   */
  renameFilePath(fromPath: string, toPath: string): void {
    if (fromPath === toPath) return;
    this.db.transaction(() => {
      this.renameOneInternal(fromPath, toPath, Date.now());
    })();
  }

  /**
   * Renames all file records whose path starts with `fromPrefix/` so they
   * start with `toPrefix/` instead. Each renamed path leaves a `deleted`
   * tombstone at its old location (see `renameFilePath`). Returns the number of
   * rows renamed.
   */
  renameFolderPaths(fromPrefix: string, toPrefix: string): number {
    if (fromPrefix === toPrefix) return 0;
    const like = fromPrefix.replace(/[%_]/g, "\\$&") + "/%";
    const prefixLen = fromPrefix.length;
    const result = this.db.transaction(() => {
      const files = this.db
        .prepare<[string]>("SELECT path FROM files WHERE path LIKE ? ESCAPE '\\'")
        .all(like) as Array<{ path: string }>;
      const now = Date.now();
      for (const { path: oldPath } of files) {
        const newPath = toPrefix + oldPath.slice(prefixLen);
        this.renameOneInternal(oldPath, newPath, now);
      }
      return files.length;
    })();
    return result as number;
  }

  /**
   * Core rename step — assumes it runs inside a transaction. Creates/repoints
   * `toPath` as active, moves version history, and tombstones `fromPath`. Both
   * the destination and the tombstone get fresh, distinct seqs so each surfaces
   * independently in the changes feed.
   */
  private renameOneInternal(fromPath: string, toPath: string, now: number): void {
    const row = this.db
      .prepare<[string], DbFileRow>("SELECT * FROM files WHERE path = ?")
      .get(fromPath);
    if (!row) return;

    const seqNew = this.allocateSeq();
    // Destination becomes active; clear any stale renamed_to (the path may have
    // been a rename tombstone from an earlier move). Size travels with the row.
    this.db
      .prepare<[string, string, number, number, string, number, number]>(
        `INSERT INTO files (path, sha1, mtime, received_at, action, file_type, seq, renamed_to, size)
         VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?)
         ON CONFLICT(path) DO UPDATE SET
           sha1        = excluded.sha1,
           mtime       = excluded.mtime,
           received_at = excluded.received_at,
           action      = 'active',
           file_type   = excluded.file_type,
           seq         = excluded.seq,
           renamed_to  = NULL,
           size        = excluded.size`
      )
      .run(toPath, row.sha1, row.mtime, now, row.file_type, seqNew, row.size ?? -1);

    this.db
      .prepare<[string, string]>("UPDATE file_versions SET path = ? WHERE path = ?")
      .run(toPath, fromPath);

    // Old path becomes a rename tombstone: deleted, but remembering where it
    // went so decideUpload can tell rename from delete.
    const seqOld = this.allocateSeq();
    this.db
      .prepare<[number, number, string, string]>(
        "UPDATE files SET action = 'deleted', received_at = ?, seq = ?, renamed_to = ? WHERE path = ?"
      )
      .run(now, seqOld, toPath, fromPath);
  }

  /**
   * If `path` is a rename tombstone, returns the path the file was renamed to;
   * otherwise null. Used by the upload gate to distinguish an edit-to-a-renamed
   * -file (structural conflict) from a re-add after a plain delete.
   */
  getRenameTarget(path: string): string | null {
    const row = this.db
      .prepare<[string], { renamed_to: string | null }>(
        "SELECT renamed_to FROM files WHERE path = ? AND action = 'deleted'"
      )
      .get(path);
    return row?.renamed_to ?? null;
  }
}
