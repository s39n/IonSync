import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FileEntry } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen, type TestClient } from "./helpers.js";

const sha1 = (s: string) => createHash("sha1").update(Buffer.from(s)).digest("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64");

function entry(path: string, content: string, mtime: number): FileEntry {
  return { path, sha1: sha1(content), mtime, action: "active", fileType: "file" };
}

async function settle(client: TestClient, path: string): Promise<void> {
  client.send({ type: "file_history", path });
  await client.nextMsg((m) => (m as { type: string }).type === "file_history_response");
}

function row(srv: Awaited<ReturnType<typeof startTestServer>>, path: string) {
  return srv.ctx.db.getFilesWithSize("active").find((f) => f.path === path);
}

describe("file attribution (created_by / last_by)", () => {
  it("stamps the creating device, preserves it across an edit from another device, tracks the last writer", async () => {
    const srv = await startTestServer();
    const a = connectClient(srv.port);
    await waitForOpen(a);
    await a.auth("pc-alpha");
    const b = connectClient(srv.port);
    await waitForOpen(b);
    await b.auth("pc-beta");

    // pc-alpha introduces the note.
    a.send({ type: "file_data", mode: "apply", file: entry("notes/x.md", "one", 1000), content: b64("one") });
    await settle(a, "notes/x.md");
    let r = row(srv, "notes/x.md");
    assert.equal(r?.createdBy, "pc-alpha");
    assert.equal(r?.lastBy, "pc-alpha");

    // pc-beta edits it (baseSha1 == head → fast-forward accept).
    b.send({ type: "file_data", mode: "apply", file: entry("notes/x.md", "two", 2000), content: b64("two"), baseSha1: sha1("one") });
    await settle(b, "notes/x.md");
    r = row(srv, "notes/x.md");
    assert.equal(r?.createdBy, "pc-alpha", "creator is preserved across later edits");
    assert.equal(r?.lastBy, "pc-beta", "last writer follows the most recent editor");

    a.close();
    b.close();
    await srv.stop();
  });

  it("leaves attribution null for a file introduced without a device id", async () => {
    const srv = await startTestServer();
    // Upsert directly with no device id (models an internal/tombstone write path).
    srv.ctx.db.upsertFile(entry("notes/y.md", "hello", 1000), 5);
    const r = row(srv, "notes/y.md");
    assert.equal(r?.createdBy, null);
    assert.equal(r?.lastBy, null);
    await srv.stop();
  });
});
