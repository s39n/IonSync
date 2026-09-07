import Database from "better-sqlite3";
import type { FileEntry, VersionEntry } from "@ionsync/protocol";
import { runMigrations } from "./migrations.js";
import { backupFilename, pruneBackups } from "../backup.js";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

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
  /** Device that first introduced this path (migration v7); null = unknown/pre-v7. */
  created_by?: string | null;
  /** Device that most recently wrote this path (migration v7). */
  last_by?: string | null;
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
  synced_seq: number;
}

interface DbConflictRow {
  id: number;
  path: string;
  sha1: string;
  mtime: number;
  device_id: string | null;
  created_at: number;
  resolved: number;
}

/** A recorded conflict (the losing side of an edit) awaiting review. */
export interface ConflictRecord {
  id: number;
  path: string;
  sha1: string;
  mtime: number;
  deviceId: string | null;
  createdAt: number;
  resolved: boolean;
}

function rowToConflict(r: DbConflictRow): ConflictRecord {
  return {
    id: r.id, path: r.path, sha1: r.sha1, mtime: r.mtime,
    deviceId: r.device_id ?? null, createdAt: r.created_at, resolved: !!r.resolved,
  };
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

  private readonly dbPath: string;

  constructor(dbDir: string, opts?: { backupDir?: string; retain?: number }) {
    fs.mkdirSync(dbDir, { recursive: true });
    this.dbPath = path.join(dbDir, "sync.db");
    // Capture existence BEFORE opening — new Database() creates the file, so a
    // fresh DB must not trigger a (pointless) pre-migration snapshot.
    const preExisting = fs.existsSync(this.dbPath);
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    // NORMAL durability is safe under WAL: a crash can lose at most the last
    // committed transaction (which the plugin will re-upload on next sync).
    // The default FULL mode does an extra fsync per write that shows up as
    // noticeable latency during bulk syncs with many small files.
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    // Pre-migration rollback point: snapshot the DB as it is on disk BEFORE any
    // migration runs, so a bad migration or startup logic can be rolled back
    // (the failure mode behind both 2026 incidents). Best-effort; never blocks boot.
    if (opts?.backupDir && preExisting) {
      try {
        const p = this.snapshot(opts.backupDir, "pre-migrate");
        pruneBackups(opts.backupDir, "pre-migrate", opts.retain ?? 7);
        console.log(`[backup] pre-migration snapshot -> ${path.basename(p)}`);
      } catch (e) {
        console.error("[backup] pre-migration snapshot failed:", e);
      }
    }
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
  /**
   * Consistent single-file DB snapshot via VACUUM INTO (synchronous, WAL-safe,
   * compacted). Returns the snapshot path; the timestamped name never collides.
   */
  snapshot(destDir: string, tag: string): string {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, backupFilename(tag));
    // VACUUM INTO takes a string literal, not a bound parameter — escape quotes.
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    return dest;
  }

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
   * Lightweight active-file manifest (path + sha1 only) for the completeness
   * audit. Excludes folders and deleted rows — a client compares this against
   * its local vault to find files it's silently missing. Selecting just two
   * columns keeps even a 50k-file manifest to a few hundred KB.
   */
  getActiveManifest(): { path: string; sha1: string }[] {
    return this.db
      .prepare<[], { path: string; sha1: string }>(
        "SELECT path, sha1 FROM files WHERE action = 'active' AND file_type = 'file'"
      )
      .all();
  }

  /**
   * @param size Content size in bytes of the version being recorded. Pass it
   *   whenever the caller has the bytes in hand (uploads, conflict copies) so
   *   dashboard size queries never have to stat the disk. Omitted → the
   *   previously stored size is kept (metadata-only updates, deletions).
   */
  upsertFile(file: FileEntry, size?: number, deviceId?: string | null): void {
    const now = Date.now();
    this.db.transaction(() => {
      const seq = this.allocateSeq();
      this.db
        .prepare<[string, string, number, number, string, string, number, number, string | null, string | null]>(
          `INSERT INTO files (path, sha1, mtime, received_at, action, file_type, seq, size, created_by, last_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             sha1        = excluded.sha1,
             mtime       = excluded.mtime,
             received_at = excluded.received_at,
             action      = excluded.action,
             file_type   = excluded.file_type,
             seq         = excluded.seq,
             -- Overwriting a path clears any stale rename-tombstone marker: an
             -- active row must never carry renamed_to, or re-deleting this file
             -- would later look like a rename and mint spurious conflict copies.
             renamed_to  = NULL,
             -- created_by is deliberately NOT updated: it records the device that
             -- first introduced the path and must survive later edits. last_by
             -- follows the most recent writer, but keep the old value when this
             -- upsert carries no device (e.g. an internal tombstone write).
             last_by     = COALESCE(excluded.last_by, files.last_by),
             size        = CASE WHEN excluded.size >= 0 THEN excluded.size ELSE files.size END`
        )
        .run(file.path, file.sha1, file.mtime, now, file.action, file.fileType, seq, size ?? -1, deviceId ?? null, deviceId ?? null);

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

  // ─── Conflicts ─────────────────────────────────────────────────────────────

  /** Record the losing side of a conflict. Returns the new conflict id, which
   *  doubles as the storage key (`_conflicts/<id>`) for its content blob. */
  recordConflict(path: string, sha1: string, mtime: number, deviceId: string | null): number {
    const info = this.db
      .prepare<[string, string, number, string | null, number]>(
        `INSERT INTO conflicts (path, sha1, mtime, device_id, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(path, sha1, mtime, deviceId, Date.now());
    return Number(info.lastInsertRowid);
  }

  /** List conflicts, newest first. Unresolved only unless includeResolved. */
  listConflicts(includeResolved = false): ConflictRecord[] {
    const rows = includeResolved
      ? this.db.prepare<[], DbConflictRow>("SELECT * FROM conflicts ORDER BY created_at DESC").all()
      : this.db.prepare<[], DbConflictRow>("SELECT * FROM conflicts WHERE resolved = 0 ORDER BY created_at DESC").all();
    return rows.map(rowToConflict);
  }

  getConflict(id: number): ConflictRecord | undefined {
    const r = this.db.prepare<[number], DbConflictRow>("SELECT * FROM conflicts WHERE id = ?").get(id);
    return r ? rowToConflict(r) : undefined;
  }

  /** Mark a conflict resolved (dismissed or restored). */
  resolveConflict(id: number): void {
    this.db.prepare<[number]>("UPDATE conflicts SET resolved = 1 WHERE id = ?").run(id);
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

  /** Record the highest cursor a device has durably applied (its sync_cursor
   *  `since`). Monotonic — never moves backward. The row already exists via
   *  touchDevice, but upsert defensively so a first message can't miss it. */
  recordDeviceSyncedSeq(id: string, seq: number): void {
    this.db
      .prepare<[string, number, number]>(
        `INSERT INTO devices (id, last_online, synced_seq) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET synced_seq = MAX(synced_seq, excluded.synced_seq)`
      )
      .run(id, Date.now(), Math.max(0, Math.floor(seq)));
  }

  /** The lowest synced_seq across all known devices — i.e. the seq every device
   *  has provably caught up to. A tombstone at or below this has been seen by
   *  everyone, so it is safe to hard-delete. With no devices there is nobody to
   *  resurrect a file, so return a sentinel that lets all tombstones purge. */
  getMinSyncedSeq(): number {
    const row = this.db
      .prepare<[], { min_s: number | null; n: number }>(
        "SELECT MIN(synced_seq) AS min_s, COUNT(*) AS n FROM devices"
      )
      .get();
    if (!row || row.n === 0) return Number.MAX_SAFE_INTEGER;
    return row.min_s ?? 0;
  }

  // --- Cleanup helpers ------------------------------------------------------

  /** Deleted-file records (tombstones) whose seq is at or below `seq` — i.e. old
   *  enough that a device caught up to `seq` has already seen the deletion. */
  getDeletedFilesUpToSeq(seq: number): FileEntry[] {
    return this.db
      .prepare<[number], DbFileRow>(
        "SELECT * FROM files WHERE action = 'deleted' AND seq <= ?"
      )
      .all(seq)
      .map(rowToFileEntry);
  }

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
  getFilesWithSize(
    action: "active" | "deleted" | "all"
  ): Array<FileWithSize & { createdBy: string | null; lastBy: string | null }> {
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
    return rows.map((r) => ({
      ...rowToFileEntry(r),
      size: r.size ?? -1,
      createdBy: r.created_by ?? null,
      lastBy: r.last_by ?? null,
    }));
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

  /**
   * The per-install E2EE salt (hex) for key-derivation format v3+ (SECURITY.md
   * #7). Generated once, on first request, and stored — so it is STABLE for the
   * life of the vault (a changing salt would strand every v3 ciphertext). Not a
   * secret: a salt only needs to be unique per install, which defeats
   * precomputation against the old fixed global salt and cross-install key
   * reuse. Handed to every device in `auth_ok`; devices persist their own copy,
   * so decryption never depends on the server after first receipt.
   */
  getOrCreateE2eeSalt(): string {
    const existing = this.getSetting("e2ee_salt");
    if (existing) return existing;
    const salt = randomBytes(16).toString("hex");
    this.setSetting("e2ee_salt", salt);
    return salt;
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
    return result;
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
