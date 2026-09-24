import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { connectClient, startTestServer, waitForOpen } from "./helpers.js";
import { isValidVaultPath } from "../src/paths.js";
import { Storage } from "../src/storage/index.js";
import { SyncDB } from "../src/db/index.js";
import { migrateLegacyConflictBlobs } from "../src/conflictMigration.js";

const sha1 = (s: string) => createHash("sha1").update(Buffer.from(s)).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(20); }
  throw new Error("condition not met");
}
function upload(c: ReturnType<typeof connectClient>, p: string, text: string, mtime: number) {
  c.send({
    type: "file_data", mode: "apply",
    file: { path: p, sha1: sha1(text), mtime, action: "active", fileType: "file" },
    content: Buffer.from(text).toString("base64"),
  });
}

describe("vault path validation", () => {
  it("accepts ordinary and hidden paths", () => {
    for (const p of ["a.md", "folder/b.md", ".obsidian/app.json", "x/.hidden/y", "100% done.md", "a..b.md"]) {
      assert.equal(isValidVaultPath(p), true, p);
    }
  });

  it("rejects root-aliasing, escaping, and malformed paths", () => {
    for (const p of ["", ".", "..", "a/..", "./a", "a/./b", "/abs", "a//b", "a/", "a\\b", "a\0b", 42, null, "x".repeat(1025)]) {
      assert.equal(isValidVaultPath(p), false, JSON.stringify(p));
    }
  });

  it("Storage refuses paths that resolve to its root", () => {
    const s = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), "ps-")));
    s.init();
    s.write("keep/me.md", 1, Buffer.from("keep"));
    for (const p of [".", "", "a/.."]) assert.throws(() => s.deleteAllVersions(p));
    assert.equal(s.readLatest("keep/me.md")?.toString(), "keep");
  });

  it("the server drops WS uploads with invalid paths and keeps valid ones", async () => {
    const srv = await startTestServer();
    const c = connectClient(srv.port); await waitForOpen(c); await c.auth("devA");
    upload(c, ".", "dot", Date.now());
    upload(c, "a/../b.md", "alias", Date.now());
    upload(c, "ok.md", "fine", Date.now());
    await until(() => !!srv.ctx.db.getFile("ok.md"));
    assert.equal(srv.ctx.db.getFile("."), undefined);
    assert.equal(srv.ctx.db.getFile("a/../b.md"), undefined);
    c.close(); await srv.stop();
  });
});

describe("conflict store isolation", () => {
  it("a vault file at _conflicts/<id> no longer touches conflict content", async () => {
    const srv = await startTestServer();
    const c = connectClient(srv.port); await waitForOpen(c); await c.auth("devA");
    const id = srv.ctx.db.recordConflict("n.md", sha1("real loser"), 1000, "devA");
    srv.ctx.conflicts.write(String(id), 1000, Buffer.from("real loser"));
    upload(c, `_conflicts/${id}`, "vault file", 5000);
    await until(() => !!srv.ctx.db.getFile(`_conflicts/${id}`));
    assert.equal(srv.ctx.conflicts.readLatest(String(id))?.toString(), "real loser");
    assert.equal(srv.ctx.storage.readLatest(`_conflicts/${id}`)?.toString(), "vault file");
    c.close(); await srv.stop();
  });

  it("migrates legacy blobs out of the file store, idempotently", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-"));
    const db = new SyncDB(path.join(tmp, "db"));
    const files = new Storage(path.join(tmp, "files")); files.init();
    const conflicts = new Storage(path.join(tmp, "conflicts")); conflicts.init();
    const id = db.recordConflict("n.md", sha1("loser"), 1000, null);
    files.write(`_conflicts/${id}`, 1000, Buffer.from("loser"));
    files.write("_conflicts/notes/keep.md", 2000, Buffer.from("user file")); // unrelated vault content

    assert.equal(migrateLegacyConflictBlobs(db, files, conflicts), 1);
    assert.equal(conflicts.readLatest(String(id))?.toString(), "loser");
    assert.equal(files.readLatest(`_conflicts/${id}`), null);
    assert.equal(files.readLatest("_conflicts/notes/keep.md")?.toString(), "user file");
    assert.equal(migrateLegacyConflictBlobs(db, files, conflicts), 0);
    db.close();
  });
});
