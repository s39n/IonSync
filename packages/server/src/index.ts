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

const db = new SyncDB(dbDir);
const storage = new Storage(filesDir);
storage.init();

const ctx = createContext(config, db, storage, clientDir);

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
publicApp.use(buildPublicRouter(ctx));

const adminApp = express();
adminApp.use(buildAdminRouter(ctx));

// ── HTTP / HTTPS servers ──────────────────────────────────────────────────────

let publicServer: http.Server | https.Server;
let adminServer: http.Server;

// 1. Setup Public Server (For the tunnel)
if (config.tls) {
  publicServer = https.createServer(
    { key: fs.readFileSync(config.tls.key), cert: fs.readFileSync(config.tls.cert) },
    publicApp
  );
} else {
  publicServer = http.createServer(publicApp);
}

// 2. Setup Admin Server (Always local HTTP)
adminServer = http.createServer(adminApp);

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

// Admin Server binds to a DIFFERENT port and strictly to localhost / private LAN
const ADMIN_PORT = config.port + 1; // e.g., 3001
const ADMIN_HOST = "0.0.0.0"; // 🚨 Change to "0.0.0.0" ONLY if you want to access it from other computers on your home WiFi

adminServer.listen(ADMIN_PORT, ADMIN_HOST, () => {
  console.log(`[Admin] Dashboard safely locked to http://${ADMIN_HOST}:${ADMIN_PORT}/dashboard`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(): void {
  cleanup.stop();
  db.close();
  adminServer.close();
  publicServer.close(() => {
    console.log("Servers stopped.");
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
