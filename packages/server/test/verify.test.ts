/**
 * Completeness-audit integration tests. The client asks the server for its
 * active-file manifest (path + sha1), diffs it locally, and pulls back anything
 * it's missing via verify_missing — the safety net for the 2026-08 silent
 * under-fetch where a "caught up" cursor hid missing files.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileEntry } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen } from "./helpers.js";

interface ManifestMsg { type: "verify_manifest"; files: { path: string; sha1: string }[]; last: boolean }
interface PushMsg { type: "file_push"; file: FileEntry; content: string }

function seed(srv: Awaited<ReturnType<typeof startTestServer>>, file: FileEntry, content: string): void {
  srv.ctx.db.upsertFile(file);
  if (file.action === "active" && file.fileType === "file") {
    srv.ctx.storage.write(file.path, file.mtime, Buffer.from(content));
  }
}
function entry(path: string, mtime: number, over: Partial<FileEntry> = {}): FileEntry {
  return { path, sha1: `sha-${path}-${mtime}`, mtime, action: "active", fileType: "file", ...over };
}

describe("verify (completeness audit)", () => {
  it("verify_request streams a manifest of ACTIVE files only (path + sha1)", async () => {
    const srv = await startTestServer();
    seed(srv, entry("a.md", 1000), "alpha");
    seed(srv, entry("b.md", 1001), "bravo");
    srv.ctx.db.upsertFile(entry("gone.md", 1002, { action: "deleted" })); // tombstone — excluded
    srv.ctx.db.upsertFile(entry("dir", 1003, { fileType: "folder" }));    // folder — excluded

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "verify_request" });
    const files: { path: string; sha1: string }[] = [];
    for (;;) {
      const m = await client.nextMsg<ManifestMsg>((x) => (x as { type: string }).type === "verify_manifest");
      files.push(...m.files);
      if (m.last) break;
    }

    assert.deepEqual(files.map((f) => f.path).sort(), ["a.md", "b.md"], "only active files, no tombstone/folder");
    assert.ok(files.every((f) => typeof f.sha1 === "string" && f.sha1.length > 0), "every entry carries a sha1");

    client.close();
    await srv.stop();
  });

  it("verify_missing re-pushes exactly the requested active files (download-only repair)", async () => {
    const srv = await startTestServer();
    seed(srv, entry("keep.md", 1000), "hello world");
    srv.ctx.db.upsertFile(entry("deleted.md", 1001, { action: "deleted" }));

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    // Ask for one real file, one deleted, one unknown — only the real active one comes back.
    client.send({ type: "verify_missing", paths: ["keep.md", "deleted.md", "nope.md"] });

    const push = await client.nextMsg<PushMsg>((x) => (x as { type: string }).type === "file_push");
    assert.equal(push.file.path, "keep.md");
    assert.equal(Buffer.from(push.content, "base64").toString(), "hello world", "content re-pushed");

    client.close();
    await srv.stop();
  });

  it("verify_request with no active files returns a single empty final chunk", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "verify_request" });
    const m = await client.nextMsg<ManifestMsg>((x) => (x as { type: string }).type === "verify_manifest");
    assert.equal(m.files.length, 0);
    assert.equal(m.last, true);

    client.close();
    await srv.stop();
  });
});
