import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "../src/storage/index.js";
import { SyncDB } from "../src/db/index.js";

const tmpStore = () => {
  const s = new Storage(fs.mkdtempSync(path.join(os.tmpdir(), "fr-")));
  s.init();
  return s;
};

describe("Storage.renameFolder safety", () => {
  it("renames a folder, including nested files", () => {
    const s = tmpStore();
    s.write("a/x.md", 1, Buffer.from("x"));
    s.write("a/sub/y.md", 2, Buffer.from("y"));
    const moved = s.renameFolder("a", "b");
    assert.equal(moved.length, 2);
    assert.equal(s.readLatest("b/x.md")?.toString(), "x");
    assert.equal(s.readLatest("b/sub/y.md")?.toString(), "y");
    assert.equal(fs.existsSync(path.join(s.root, "a")), false);
  });

  it("refuses to move a folder into its own subtree (used to delete everything)", () => {
    const s = tmpStore();
    s.write("a/x.md", 1, Buffer.from("precious"));
    assert.throws(() => s.renameFolder("a", "a/b"), /own subtree/);
    assert.throws(() => s.renameFolder("a/b", "a"), /own subtree/);
    assert.equal(s.readLatest("a/x.md")?.toString(), "precious");
  });

  it("refuses up front when a destination file exists, moving nothing", () => {
    const s = tmpStore();
    s.write("a/x.md", 1, Buffer.from("from a"));
    s.write("a/z.md", 1, Buffer.from("z"));
    s.write("b/x.md", 5, Buffer.from("already in b"));
    assert.throws(() => s.renameFolder("a", "b"), /already exists/);
    assert.equal(s.readLatest("a/x.md")?.toString(), "from a");
    assert.equal(s.readLatest("a/z.md")?.toString(), "z");
    assert.equal(s.readLatest("b/x.md")?.toString(), "already in b");
  });
});

describe("SyncDB.renameFolderPaths", () => {
  it("matches the prefix case-sensitively", () => {
    const db = new SyncDB(fs.mkdtempSync(path.join(os.tmpdir(), "frdb-")));
    const f = (p: string) => ({ path: p, sha1: "s", mtime: 1, action: "active" as const, fileType: "file" as const });
    db.upsertFile(f("notes/a.md"));
    db.upsertFile(f("Notes/b.md"));
    assert.equal(db.renameFolderPaths("notes", "journal"), 1);
    assert.equal(db.getFile("journal/a.md")?.action, "active");
    assert.equal(db.getFile("Notes/b.md")?.action, "active");
    assert.equal(db.getFile("journal/b.md"), undefined);
    db.close();
  });
});
