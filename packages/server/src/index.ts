import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { mergeConfig } from "./config.js";
import { SyncDB } from "./db/index.js";
import { Storage } from "./storage/index.js";
import { createContext } from "./context.js";
import { attachWebSocketServer } from "./ws/server.js";
import { buildPublicRouter, buildAdminRouter } from "./http/routes.js";
import { SyncCleanup } from "./cleanup/index.js";
import { startBackupScheduler } from "./backup.js";
import { sealTotpSecret, isSealed } from "./totpSecret.js";

// ── Config ────────────────────────────────────────────────────────────────────

const configPath = path.resolve(process.argv[2] ?? "config.js");
if (!fs.existsSync(configPath)) {
  const examplePath = path.join(path.dirname(configPath), "config.example.js");
  console.error(`\nRequired config file not found: ${configPath}`);
  if (fs.existsSync(examplePath)) {
    console.error("\nCopy config.example.js to config.js and fill in your settings.");
  }
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rawConfig = await import(configPath);
const config = mergeConfig(rawConfig.default ?? rawConfig);

// ── Logging ───────────────────────────────────────────────────────────────────

// Wrap console.log/warn/error so messages are captured into the in-memory ring
// buffer exposed by GET /api/logs.  Patched after ctx is created below.

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Use path.resolve so an absolute dataDir (e.g. "/data" from Docker) is
// honoured as-is rather than being appended to appDir.
const dataBase = path.resolve(config.appDir, config.dataDir);
const dbDir = path.join(dataBase, "db");
const filesDir = path.join(dataBase, "files");
const clientDir = path.join(config.appDir, "client");

const backupDir = path.join(dataBase, "backups");
const db = new SyncDB(dbDir, { backupDir, retain: config.backup.retain });
const storage = new Storage(filesDir);
storage.init();

const ctx = createContext(config, db, storage, clientDir);

// One-time migration (SECURITY.md #10): seal a legacy plaintext TOTP secret at
// rest so a leaked DB or backup can't clone the 2FA seed. Idempotent — sealed
// secrets are skipped. Runs before the servers accept traffic.
{
  const storedTotp = db.getSetting("totp_secret");
  if (storedTotp && !isSealed(storedTotp)) {
    db.setSetting("totp_secret", sealTotpSecret(storedTotp, config.password, db.getOrCreateE2eeSalt()));
    console.log("[migrate] sealed the TOTP secret at rest");
  }
}

// Nightly DB snapshots (in addition to the pre-migration snapshot SyncDB takes
// on startup). VACUUM INTO → data/backups/. Timer is unref'd so it never blocks
// shutdown; see backup.ts.
const stopBackups = startBackupScheduler(
  (dir, tag) => db.snapshot(dir, tag),
  backupDir,
  { intervalMs: config.backup.intervalHours * 60 * 60 * 1000, retain: config.backup.retain },
);

// Patch console methods to feed into the in-memory log buffer (200 lines max).
const MAX_LOG = 200;
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
function appendLog(level: string, args: unknown[]): void {
  const line = `[${level}] ${args.map(String).join(" ")}`;
  ctx.logBuffer.push(line);
  if (ctx.logBuffer.length > MAX_LOG) ctx.logBuffer.shift();
}
console.log   = (...args) => { _log(...args);   appendLog("INFO",  args); };
console.warn  = (...args) => { _warn(...args);  appendLog("WARN",  args); };
console.error = (...args) => { _error(...args); appendLog("ERROR", args); };

// ── Express apps ──────────────────────────────────────────────────────────────

const publicApp = express();
publicApp.disable("x-powered-by");
publicApp.use(buildPublicRouter(ctx));

const adminApp = express();
adminApp.disable("x-powered-by");
// Behind a TLS-terminating reverse proxy, trust X-Forwarded-Proto so req.secure
// reflects the real client scheme and the session cookie is marked Secure.
// Off by default — only safe when a trusted proxy sits in front (see config).
if (config.trustProxy) adminApp.set("trust proxy", true);
adminApp.use(buildAdminRouter(ctx));

// ── HTTP / HTTPS servers ──────────────────────────────────────────────────────

let publicServer: http.Server | https.Server;
let adminServer: http.Server | https.Server;

// 1. Setup Public Server (For the tunnel)
if (config.tls) {
  publicServer = https.createServer(
    { key: fs.readFileSync(config.tls.key), cert: fs.readFileSync(config.tls.cert) },
    publicApp
  );
} else {
  publicServer = http.createServer(publicApp);
}

// 2. Setup Admin Server — HTTPS when adminTls is configured, else plain HTTP.
if (config.adminTls) {
  adminServer = https.createServer(
    { key: fs.readFileSync(config.adminTls.key), cert: fs.readFileSync(config.adminTls.cert) },
    adminApp
  );
} else {
  adminServer = http.createServer(adminApp);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

// Attach the WebSocket ONLY to the public server
attachWebSocketServer(ctx, publicServer);

// ── Cleanup ───────────────────────────────────────────────────────────────────

const cleanup = new SyncCleanup(ctx);
cleanup.start();

// ── Listen ────────────────────────────────────────────────────────────────────

// Public Server binds to your standard port (e.g., 3000) and host (e.g., 0.0.0.0)
publicServer.listen(config.port, config.host, () => {
  const scheme = config.tls ? "wss" : "ws";
  console.log(`[Public] IonSync Engine listening on ${scheme}://${config.host}:${config.port}`);
});

// Admin Server binds to a DIFFERENT port. Default bind is 127.0.0.1 (loopback
// only) — the dashboard session runs over plain HTTP and its cookie authorises
// destructive actions, so exposing it beyond the machine is an explicit opt-in
// via `adminHost: "0.0.0.0"` in config.js (the Docker entrypoint sets this,
// where the container boundary provides the isolation).
adminServer.listen(config.adminPort, config.adminHost, () => {
  const exposure = config.adminHost === "127.0.0.1" || config.adminHost === "localhost"
    ? "localhost only"
    : `bound to ${config.adminHost} — reachable from the network`;
  const scheme = config.adminTls ? "https" : "http";
  const secureNote = config.adminTls
    ? " — session cookie is Secure"
    : config.trustProxy
      ? " — Secure cookie when reached over HTTPS via the trusted proxy"
      : "";
  console.log(`[Admin] Dashboard on ${scheme}://${config.adminHost}:${config.adminPort}/dashboard (${exposure})${secureNote}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down…");
  cleanup.stop();
  stopBackups();
  adminServer.close();
  publicServer.close(() => {
    // Close the DB after the servers stop accepting work so in-flight
    // handlers aren't left with a closed handle.
    db.close();
    console.log("Servers stopped.");
    process.exit(0);
  });
  // Docker sends SIGTERM and waits ~10s before SIGKILL; if a peer holds the
  // socket open past 5s, exit anyway — WAL mode keeps the DB consistent.
  setTimeout(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  }, 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
