/**
 * Cursor-based delta sync integration tests (sync redesign phase 1).
 *
 * Server state is seeded directly via the DB + storage (like the push tests in
 * sync.test.ts) so we exercise the `sync_cursor` handler end-to-end over a real
 * WebSocket without uploading through the conflict gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileEntry } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen, type TestClient } from "./helpers.js";

interface PushMsg { type: "file_push"; file: FileEntry; content: string; seq?: number; session?: boolean }
interface DoneMsg { type: "sync_done"; cursor?: number; more?: boolean }

function seed(srv: Awaited<ReturnType<typeof startTestServer>>, file: FileEntry, content: string): void {
  srv.ctx.db.upsertFile(file);
  if (file.action === "active" && file.fileType === "file") {
    srv.ctx.storage.write(file.path, file.mtime, Buffer.from(content));
  }
}

function entry(path: string, mtime: number, over: Partial<FileEntry> = {}): FileEntry {
  return { path, sha1: `sha-${path}-${mtime}`, mtime, action: "active", fileType: "file", ...over };
}

/** Collect every file_push until the terminating sync_done. */
async function drain(client: TestClient): Promise<{ pushes: PushMsg[]; done: DoneMsg }> {
  const pushes: PushMsg[] = [];
  for (;;) {
    const m = await client.nextMsg<PushMsg | DoneMsg>(
      (x) => (x as { type: string }).type === "file_push" || (x as { type: string }).type === "sync_done"
    );
    if (m.type === "sync_done") return { pushes, done: m };
    pushes.push(m);
  }
}

describe("sync_cursor", () => {
  it("bootstrap (since:0) streams every active file with its seq, then sync_done{cursor}", async () => {
    const srv = await startTestServer();
    seed(srv, entry("a.md", 1000), "alpha");
    seed(srv, entry("b.md", 1001), "bravo");
    const current = srv.ctx.db.getCurrentSeq();

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "sync_cursor", since: 0 });
    const { pushes, done } = await drain(client);

    assert.deepEqual(pushes.map((p) => p.file.path).sort(), ["a.md", "b.md"]);
    assert.ok(pushes.every((p) => typeof p.seq === "number"), "each push carries its seq");
    assert.ok(pushes.every((p) => p.session === true), "session pushes are flagged so the client checkpoints only the ordered stream");
    assert.equal(Buffer.from(pushes.find((p) => p.file.path === "a.md")!.content, "base64").toString(), "alpha");
    assert.equal(done.cursor, current, "sync_done reports the current counter as the new cursor");

    client.close();
    await srv.stop();
  });

  it("delta (since:N) streams only changes after the cursor", async () => {
    const srv = await startTestServer();
    seed(srv, entry("a.md", 1000), "alpha");
    const cursor = srv.ctx.db.getCurrentSeq();
    seed(srv, entry("b.md", 1001), "bravo"); // the only change past `cursor`

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "sync_cursor", since: cursor });
    const { pushes, done } = await drain(client);

    assert.deepEqual(pushes.map((p) => p.file.path), ["b.md"], "only the post-cursor change");
    assert.ok(pushes[0]!.seq! > cursor, "delivered seq is past the cursor");
    assert.equal(done.cursor, srv.ctx.db.getCurrentSeq());

    client.close();
    await srv.stop();
  });

  it("nothing new → immediate sync_done with the same cursor", async () => {
    const srv = await startTestServer();
    seed(srv, entry("a.md", 1000), "alpha");
    const cursor = srv.ctx.db.getCurrentSeq();

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "sync_cursor", since: cursor });
    const { pushes, done } = await drain(client);

    assert.equal(pushes.length, 0);
    assert.equal(done.cursor, cursor);

    client.close();
    await srv.stop();
  });

  it("conveys a deletion as a tombstone push in the feed", async () => {
    const srv = await startTestServer();
    seed(srv, entry("gone.md", 1000), "here");
    const cursor = srv.ctx.db.getCurrentSeq();
    // Tombstone the file (mirrors a delete upload).
    srv.ctx.db.upsertFile(entry("gone.md", 1500, { action: "deleted" }));

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "sync_cursor", since: cursor });
    const { pushes } = await drain(client);

    const del = pushes.find((p) => p.file.path === "gone.md");
    assert.ok(del, "deletion surfaces in the feed");
    assert.equal(del!.file.action, "deleted", "delivered as a tombstone, not an active file");

    client.close();
    await srv.stop();
  });

  it("delivers a large bootstrap in bounded batches (more flag)", async () => {
    const srv = await startTestServer();
    const N = 260; // > BATCH (250)
    for (let i = 0; i < N; i++) seed(srv, entry(`n${i}.md`, 1000 + i), `c${i}`);

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    // First batch is capped and signals more.
    client.send({ type: "sync_cursor", since: 0 });
    const b1 = await drain(client);
    assert.equal(b1.pushes.length, 250, "first batch capped at BATCH");
    assert.equal(b1.done.more, true, "more remains after a full batch");

    // Client pulls the next batch with the returned cursor.
    client.send({ type: "sync_cursor", since: b1.done.cursor! });
    const b2 = await drain(client);
    assert.equal(b2.pushes.length, 10, "remainder delivered in the next batch");
    assert.ok(!b2.done.more, "no more after the final batch");

    const all = [...b1.pushes, ...b2.pushes].map((p) => p.file.path);
    assert.equal(new Set(all).size, N, "every file delivered exactly once across batches");

    client.close();
    await srv.stop();
  });

  it("caps a batch by total bytes, not just count", async () => {
    const srv = await startTestServer();
    const big = "x".repeat(3 * 1024 * 1024); // 3 MB each; cap is 8 MB
    for (let i = 0; i < 4; i++) seed(srv, entry(`big${i}.bin`, 1000 + i), big);

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    // 8 MB cap → two 3 MB files fit, the third would exceed → batch of 2, more.
    client.send({ type: "sync_cursor", since: 0 });
    const b1 = await drain(client);
    assert.equal(b1.pushes.length, 2, "byte cap cuts the batch before the 250 count cap");
    assert.equal(b1.done.more, true);

    client.send({ type: "sync_cursor", since: b1.done.cursor! });
    const b2 = await drain(client);
    assert.equal(b2.pushes.length, 2, "remaining large files arrive in the next batch");
    assert.ok(!b2.done.more, "no more after the final batch");

    client.close();
    await srv.stop();
  });

  it("a cursor ahead of the server forces a full bootstrap", async () => {
    const srv = await startTestServer();
    seed(srv, entry("a.md", 1000), "alpha");
    const current = srv.ctx.db.getCurrentSeq();

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "sync_cursor", since: current + 9999 });
    const { pushes, done } = await drain(client);

    assert.deepEqual(pushes.map((p) => p.file.path), ["a.md"], "re-delivers everything from seq 0");
    assert.equal(done.cursor, current, "reports the real current counter, not the stale-high since");

    client.close();
    await srv.stop();
  });
});
