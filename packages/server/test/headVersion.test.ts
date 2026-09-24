import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connectClient, startTestServer, waitForOpen } from "./helpers.js";
import { readHead } from "../src/head.js";
import { SyncCleanup } from "../src/cleanup/index.js";

const sha1 = (s: string) => createHash("sha1").update(Buffer.from(s)).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(20); }
  throw new Error("condition not met");
}
function upload(c: ReturnType<typeof connectClient>, p: string, text: string, mtime: number, baseSha1?: string) {
  c.send({
    type: "file_data", mode: "apply",
    file: { path: p, sha1: sha1(text), mtime, action: "active", fileType: "file" },
    content: Buffer.from(text).toString("base64"),
    ...(baseSha1 ? { baseSha1 } : {}),
  });
}

describe("head content with skewed device clocks", () => {
  it("serves the accepted head even when an older version has a larger mtime", async () => {
    const srv = await startTestServer();
    const a = connectClient(srv.port); await waitForOpen(a); await a.auth("devA");
    const b = connectClient(srv.port); await waitForOpen(b); await b.auth("devB");
    const now = Date.now();
    const A = "from A (clock +1 day)", B = "from B (newer edit)";
    upload(a, "note.md", A, now + 86_400_000);
    await until(() => srv.ctx.db.getFile("note.md")?.sha1 === sha1(A));
    upload(b, "note.md", B, now, sha1(A));
    await until(() => srv.ctx.db.getFile("note.md")?.sha1 === sha1(B));

    assert.equal(readHead(srv.ctx, "note.md")?.toString(), B);

    // A download request (mode "send", latest) returns B's bytes too.
    b.send({ type: "file_data", mode: "send", path: "note.md" });
    const resp = await b.nextMsg<{ content: string }>((m) => (m as { type: string }).type === "file_data_response");
    assert.equal(Buffer.from(resp.content, "base64").toString(), B);
    a.close(); b.close(); await srv.stop();
  });

  it("cleanup keeps the head version even if it has the smallest mtime", async () => {
    const srv = await startTestServer({ cleanup: { versionsPerFile: 1 } });
    const c = connectClient(srv.port); await waitForOpen(c); await c.auth("devA");
    const now = Date.now();
    upload(c, "n.md", "v1 future", now + 86_400_000);
    await until(() => srv.ctx.db.getFile("n.md")?.sha1 === sha1("v1 future"));
    upload(c, "n.md", "v2 head", now, sha1("v1 future"));
    await until(() => srv.ctx.db.getFile("n.md")?.sha1 === sha1("v2 head"));
    new SyncCleanup(srv.ctx).run();
    assert.equal(readHead(srv.ctx, "n.md")?.toString(), "v2 head");
    assert.equal(srv.ctx.db.getVersions("n.md").length, 1);
    c.close(); await srv.stop();
  });

  it("a same-mtime overwrite drops the stale version row", async () => {
    const srv = await startTestServer();
    const c = connectClient(srv.port); await waitForOpen(c); await c.auth("devA");
    upload(c, "s.md", "first", 1000);
    await until(() => srv.ctx.db.getFile("s.md")?.sha1 === sha1("first"));
    upload(c, "s.md", "second", 1000, sha1("first"));
    await until(() => srv.ctx.db.getFile("s.md")?.sha1 === sha1("second"));
    const shas = srv.ctx.db.getVersions("s.md").map((v) => v.sha1);
    assert.deepEqual(shas, [sha1("second")]);
    c.close(); await srv.stop();
  });
});
