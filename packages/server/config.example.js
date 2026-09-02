// AnySocket Sync Server v2 — example config
// Copy this file to config.js and fill in your settings.

export default {
  // ── Required ──────────────────────────────────────────────────────────────
  password: "change-me",

  // ── Network ───────────────────────────────────────────────────────────────
  port: 3000,
  host: "0.0.0.0",

  // TLS — uncomment to enable HTTPS/WSS
  // tls: {
  //   key:  "/path/to/privkey.pem",
  //   cert: "/path/to/fullchain.pem",
  // },

  // ── Storage ───────────────────────────────────────────────────────────────
  // dataDir: "data",   // relative to the server package root

  // ── Cleanup ───────────────────────────────────────────────────────────────
  cleanup: {
    intervalSecs: 3600,       // run cleanup every hour
    versionsPerFile: 5,        // keep at most 5 historical versions per file
    keepDeletedFilesSecs: 7 * 24 * 3600,  // purge deleted files after 7 days
  },

  // ── Backups ───────────────────────────────────────────────────────────────
  // Automatic SQLite snapshots (VACUUM INTO) written to <dataDir>/backups/.
  // A pre-migration snapshot is always taken on startup (a rollback point if a
  // migration goes wrong); the settings below tune the periodic ones.
  // Env overrides: BACKUP_INTERVAL_HOURS, BACKUP_RETAIN.
  backup: {
    intervalHours: 24,  // snapshot this often while running
    retain: 7,          // keep this many of each kind (daily / pre-migrate)
  },

  // ── Logging ───────────────────────────────────────────────────────────────
  logs: {
    level: 3,  // 0=silent  1=error  2=warn  3=info
  },
};
