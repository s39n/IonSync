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
import { buildRouter } from "./http/routes.js";
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

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(buildRouter(ctx));

// ── HTTP / HTTPS server ───────────────────────────────────────────────────────

let server: http.Server | https.Server;

if (config.tls) {
  server = https.createServer(
    {
      key: fs.readFileSync(config.tls.key),
      cert: fs.readFileSync(config.tls.cert),
    },
    app
  );
} else {
  server = http.createServer(app);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

attachWebSocketServer(ctx, server);

// ── Cleanup ───────────────────────────────────────────────────────────────────

const cleanup = new SyncCleanup(ctx);
cleanup.start();

// ── Listen ────────────────────────────────────────────────────────────────────

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? "wss" : "ws";
  console.log(`IonSync Server v2 listening on ${scheme}://${config.host}:${config.port}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(): void {
  cleanup.stop();
  db.close();
  server.close(() => {
    console.log("Server stopped.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
