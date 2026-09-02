import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SyncDB } from "../src/db/index.js";
import { pruneBackups } from "../src/backup.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ionsync-bak-"));
}

test("snapshot() produces a consistent single-file copy of the DB", () => {
  const dir = tmpdir();
  const db = new SyncDB(path.join(dir, "db"));
  db.setSetting("hello", "world");
  const snap = db.snapshot(path.join(dir, "backups"), "daily");
  db.close();

  assert.ok(fs.existsSync(snap), "snapshot file should exist");
  const copy = new Database(snap, { readonly: true });
  const row = copy.prepare("SELECT value FROM settings WHERE key = ?").get("hello") as
    | { value: string }
    | undefined;
  copy.close();
  assert.equal(row?.value, "world", "snapshot should contain the committed data");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a pre-migration snapshot is taken only when the DB pre-exists", () => {
  const dir = tmpdir();
  const dbDir = path.join(dir, "db");
  const backups = path.join(dir, "backups");

  // First run creates the DB → fresh, so no pre-migration snapshot.
  const a = new SyncDB(dbDir, { backupDir: backups });
  a.setSetting("k", "v");
  a.close();
  const afterFirst = fs.existsSync(backups)
    ? fs.readdirSync(backups).filter((f) => f.startsWith("sync-pre-migrate-")).length
    : 0;
  assert.equal(afterFirst, 0, "a fresh DB must not snapshot before its first migration");

  // Second run: the DB pre-exists → exactly one pre-migration snapshot.
  const b = new SyncDB(dbDir, { backupDir: backups });
  b.close();
  const snaps = fs.readdirSync(backups).filter((f) => f.startsWith("sync-pre-migrate-"));
  assert.equal(snaps.length, 1, "a pre-existing DB must snapshot before migrations run");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("pruneBackups keeps only the newest N for a tag", () => {
  const dir = tmpdir();
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(dir, `sync-daily-2026-09-0${i}T00-00-00.db`), "x");
  }
  // A different tag must be untouched by daily pruning.
  fs.writeFileSync(path.join(dir, "sync-pre-migrate-2026-09-01T00-00-00.db"), "x");

  pruneBackups(dir, "daily", 2);
  const left = fs.readdirSync(dir).filter((f) => f.endsWith(".db")).sort();
  assert.deepEqual(left, [
    "sync-daily-2026-09-04T00-00-00.db",
    "sync-daily-2026-09-05T00-00-00.db",
    "sync-pre-migrate-2026-09-01T00-00-00.db",
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});
