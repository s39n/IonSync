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

  // ── Logging ───────────────────────────────────────────────────────────────
  logs: {
    level: 3,  // 0=silent  1=error  2=warn  3=info
  },
};
