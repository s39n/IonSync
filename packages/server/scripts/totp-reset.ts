#!/usr/bin/env tsx
/**
 * Emergency TOTP reset — run this on the server when you are locked out.
 *
 * Usage (from packages/server/):
 *   npm run totp:reset
 *
 * This script opens the SQLite database directly, clears the stored TOTP
 * secret and all recovery codes, then exits. The server does not need to be
 * stopped first — SQLite WAL mode allows concurrent access.
 *
 * After running, reload the dashboard and log in with your password as usual.
 */
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");

// ── Locate the database ──────────────────────────────────────────────────────

let dataDir: string | undefined;

try {
  const cfgPath = path.join(serverRoot, "config.js");
  if (fs.existsSync(cfgPath)) {
    // Dynamic import works for both ESM and CJS config exports
    const mod = await import(cfgPath);
    const cfg = mod.default ?? mod;
    if (typeof cfg.dataDir === "string") dataDir = cfg.dataDir;
  }
} catch {
  // Config unreadable — fall through to default
}

if (!dataDir) {
  dataDir = path.join(serverRoot, "data");
  console.warn(`⚠  Could not read config.js — assuming dataDir: ${dataDir}`);
}

const dbPath = path.join(dataDir, "db", "sync.db");

if (!fs.existsSync(dbPath)) {
  console.error(`✗ Database not found at: ${dbPath}`);
  console.error(`  Make sure you're running this from packages/server/ and the server has started at least once.`);
  process.exit(1);
}

// ── Clear TOTP settings ──────────────────────────────────────────────────────

const db = new Database(dbPath);

const secretRow = db
  .prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'totp_secret'")
  .get();

if (!secretRow) {
  console.log("ℹ  2FA is not currently enabled — nothing to reset.");
  db.close();
  process.exit(0);
}

db.transaction(() => {
  db.prepare("DELETE FROM settings WHERE key IN ('totp_secret', 'totp_recovery_codes')").run();
})();

db.close();

console.log("");
console.log("✓  2FA has been disabled successfully.");
console.log("   Reload the dashboard and sign in with your password.");
console.log("");
