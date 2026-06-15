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

interface PushMsg { type: "file_push"; file: FileEntry; content: string; seq?: number }
interface DoneMsg { type: "sync_done"; cursor?: number }

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
