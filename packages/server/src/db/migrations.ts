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
