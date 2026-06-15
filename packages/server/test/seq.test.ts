/**
 * Sequence-cursor tests (sync redesign phase 0).
 *
 * Exercises SyncDB directly — no WS server. The DB layer stores content
 * verbatim (SHA1 verification lives in the upload handler), so these tests use
 * arbitrary sha1 strings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SyncDB } from "../src/db/index.js";
import type { FileEntry } from "@ionsync/protocol";

function tmpDb(): { db: SyncDB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ionsync-seq-"));
  const db = new SyncDB(path.join(dir, "db"));
  return { db, dir };
}

function cleanup(db: SyncDB, dir: string): void {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function entry(p: string, sha1: string, mtime: number, over: Partial<FileEntry> = {}): FileEntry {
  return { path: p, sha1, mtime, action: "active", fileType: "file", ...over };
}

test("seq strictly increases on every upsert", () => {
  const { db, dir } = tmpDb();
  try {
    assert.equal(db.getCurrentSeq(), 0, "fresh db starts at seq 0");

    db.upsertFile(entry("a.md", "sha-a", 1000));
    const s1 = db.getCurrentSeq();
    db.upsertFile(entry("b.md", "sha-b", 1001));
    const s2 = db.getCurrentSeq();
    db.upsertFile(entry("a.md", "sha-a2", 1002)); // modify existing
    const s3 = db.getCurrentSeq();

    assert.ok(s1 < s2 && s2 < s3, `seqs strictly increase: ${s1} < ${s2} < ${s3}`);

    // Every change carries a distinct, ascending seq.
    const changes = db.getChangesSince(0, 100);
    const seqs = changes.map((c) => c.seq);
    assert.deepEqual([...seqs].sort((x, y) => x - y), seqs, "changes are seq-ascending");
    assert.equal(new Set(seqs).size, seqs.length, "seqs are unique");
  } finally {
    cleanup(db, dir);
  }
});

test("getChangesSince returns only changes after the cursor", () => {
  const { db, dir } = tmpDb();
  try {
    db.upsertFile(entry("a.md", "sha-a", 1000));
    db.upsertFile(entry("b.md", "sha-b", 1001));

    const first = db.getChangesSince(0, 100);
    assert.deepEqual(first.map((c) => c.path), ["a.md", "b.md"]);
    const cursor = first[first.length - 1]!.seq;

    // Nothing new yet.
    assert.deepEqual(db.getChangesSince(cursor, 100), []);

    db.upsertFile(entry("c.md", "sha-c", 1002));
    db.upsertFile(entry("a.md", "sha-a2", 1003)); // re-touch a.md

    const delta = db.getChangesSince(cursor, 100);
    assert.deepEqual(delta.map((c) => c.path), ["c.md", "a.md"], "only post-cursor changes, seq order");
    assert.ok(delta.every((c) => c.seq > cursor), "all returned seqs are past the cursor");
  } finally {
    cleanup(db, dir);
  }
});

test("counter stays monotonic across a purge (no seq reuse)", () => {
  const { db, dir } = tmpDb();
  try {
    db.upsertFile(entry("a.md", "sha-a", 1000)); // seq 1
    db.upsertFile(entry("b.md", "sha-b", 1001)); // seq 2
    db.upsertFile(entry("b.md", "sha-b", 1002, { action: "deleted" })); // seq 3 (tombstone)

    const beforePurge = db.getCurrentSeq();
    db.purgeDeletedFiles("b.md"); // hard-deletes the row holding seq 3

    db.upsertFile(entry("c.md", "sha-c", 1003));
    const cChange = db.getChangesSince(beforePurge, 100).find((c) => c.path === "c.md");

    assert.ok(cChange, "new file appears in the changes feed");
    assert.ok(
      cChange!.seq > beforePurge,
      `new seq ${cChange!.seq} must exceed pre-purge counter ${beforePurge} — never reused`
    );
  } finally {
    cleanup(db, dir);
  }
});

test("getChangesSince honors the limit and stays seq-ordered", () => {
  const { db, dir } = tmpDb();
  try {
    for (let i = 0; i < 5; i++) db.upsertFile(entry(`f${i}.md`, `sha-${i}`, 2000 + i));

    const page = db.getChangesSince(0, 2);
    assert.equal(page.length, 2, "limit caps the page size");
    assert.ok(page[0]!.seq < page[1]!.seq, "page is seq-ascending");

    const next = db.getChangesSince(page[1]!.seq, 100);
    assert.equal(next.length, 3, "remaining changes follow the page");
  } finally {
    cleanup(db, dir);
  }
});
