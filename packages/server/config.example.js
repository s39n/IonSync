// IonSync Server — example config
// Copy this file to config.js and fill in your settings.

export default {
  // ── Required ──────────────────────────────────────────────────────────────
  password: "change-me",

  // ── Network ───────────────────────────────────────────────────────────────
  port: 3000,
  host: "0.0.0.0",

  // TLS for the public sync server — uncomment to enable HTTPS/WSS
  // tls: {
  //   key:  "/path/to/privkey.pem",
  //   cert: "/path/to/fullchain.pem",
  // },

  // ── Admin dashboard security ───────────────────────────────────────────────
  // The dashboard cookie authorises destructive actions, so protect it in transit.
  // Two ways to serve the dashboard over HTTPS (either one marks the cookie Secure):
  //
  //   (a) Native TLS — give the dashboard its own cert (self-signed is fine on a LAN):
  //   adminTls: {
  //     key:  "/certs/dashboard-key.pem",
  //     cert: "/certs/dashboard-cert.pem",
  //   },
  //
  //   (b) Behind a reverse proxy (Caddy/nginx/Traefik) that terminates TLS —
  //   trust its X-Forwarded-Proto so the cookie is marked Secure. Enable this
  //   ONLY when such a proxy is actually in front (else a client could spoof it).
  //   Env override: TRUST_PROXY=1
  // trustProxy: true,
  //
  // Left unset, the dashboard stays on plain HTTP — fine for a loopback/LAN-only
  // deployment (the default adminHost is 127.0.0.1).

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
