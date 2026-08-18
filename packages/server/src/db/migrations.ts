import type Database from "better-sqlite3";

/**
 * All schema migrations in version order.
 * Each entry is applied exactly once and recorded in the `schema_version` table.
 * Never edit a past migration — add a new one instead.
 */
export const MIGRATIONS: Array<{ version: number; up: (db: Database.Database) => void }> = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY
        );

        CREATE TABLE IF NOT EXISTS devices (
          id          TEXT    PRIMARY KEY,
          last_online INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS files (
          path        TEXT    PRIMARY KEY,
          sha1        TEXT    NOT NULL,
          mtime       INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          action      TEXT    NOT NULL DEFAULT 'active',
          file_type   TEXT    NOT NULL DEFAULT 'file'
        );

        CREATE TABLE IF NOT EXISTS file_versions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          path        TEXT    NOT NULL,
          sha1        TEXT    NOT NULL,
          mtime       INTEGER NOT NULL,
          received_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_file_versions_path
          ON file_versions (path);

        CREATE INDEX IF NOT EXISTS idx_file_versions_mtime
          ON file_versions (path, mtime DESC);
      `);
    },
  },
  {
    version: 2,
    up(db) {
      // Key-value store used by server features (e.g. TOTP secret).
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 3,
    up(db) {
      // Monotonic sync sequence cursor (sync redesign — phase 0).
      //
      // Every change to a file's head is stamped with an ever-increasing `seq`
      // so a reconnecting client can request only `changes WHERE seq > cursor`
      // instead of re-diffing the whole tree. The authoritative counter lives
      // in `settings` (key `sync_seq`) rather than MAX(seq) over `files`,
      // because `purgeDeletedFiles` hard-deletes rows — using MAX(seq) would let
      // a seq value be reused and a client could miss a change.
      db.exec(`
        ALTER TABLE files ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

        CREATE INDEX IF NOT EXISTS idx_files_seq ON files (seq);

        -- Backfill existing rows with a stable, increasing seq (rowid order).
        UPDATE files
          SET seq = (SELECT COUNT(*) FROM files f2 WHERE f2.rowid <= files.rowid);

        -- Seed the monotonic counter to the current max seq.
        INSERT INTO settings (key, value)
          VALUES ('sync_seq', CAST((SELECT COALESCE(MAX(seq), 0) FROM files) AS TEXT))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      `);
    },
  },
  {
    version: 4,
    up(db) {
      // Structural-conflict support. When a file is retired by a *rename* (not a
      // plain delete), its tombstone records where it went. A later upload whose
      // baseSha1 matches the pre-rename head is then recognised as an edit to a
      // renamed file (structural conflict) and diverted to a conflicted copy of
      // the rename target — instead of hitting the `action='deleted' → accept`
      // branch in decideUpload and silently resurrecting the old path.
      db.exec(`ALTER TABLE files ADD COLUMN renamed_to TEXT;`);
    },
  },
  {
    version: 5,
    up(db) {
      // Content size (bytes) of the file's head version, stamped at upload
      // time. -1 = unknown (row predates this migration); readers fall back to
      // a storage stat for those rows. Before this column existed, every
      // dashboard file/stats endpoint did a readdir per file to discover sizes
      // — 50k+ directory scans per 5-second dashboard poll on a large vault.
      db.exec(`ALTER TABLE files ADD COLUMN size INTEGER NOT NULL DEFAULT -1;`);
    },
  },
  {
    version: 6,
    up(db) {
      // Highest sync cursor each device has durably applied (the `since` it sends
      // on sync_cursor — the client only advances it over files it actually wrote,
      // per the 2026-08 under-fetch hardening). Lets cleanup hard-delete a
      // tombstone as soon as EVERY device has synced past its seq, instead of the
      // old fixed 7-day wait: a delete a device hasn't seen yet still has
      // seq > that device's synced_seq, so it is never purged out from under it.
      // Default 0 = "has synced nothing yet"; existing devices update on next sync.
      db.exec(`ALTER TABLE devices ADD COLUMN synced_seq INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    version: 7,
    up(db) {
      // File attribution for the dashboard. `created_by` = the device that first
      // introduced a path (stamped once, preserved across later edits);
      // `last_by` = the device that most recently wrote it. Existing rows stay
      // NULL (no historical record) and populate going forward.
      db.exec(`
        ALTER TABLE files ADD COLUMN created_by TEXT;
        ALTER TABLE files ADD COLUMN last_by TEXT;
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  // Ensure version table exists before reading it
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  `);

  const getCurrentVersion = db.prepare<[], { version: number }>(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_version"
  );
  let current = getCurrentVersion.get()?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > current) {
      const applyMigration = db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (?)").run(
          migration.version
        );
      });
      applyMigration();
      current = migration.version;
    }
  }
}
