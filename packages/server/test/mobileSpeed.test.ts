import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { APP_PING_CAP, PIPELINED_AUTH_CAP } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen, TEST_PASSWORD, type TestClient } from "./helpers.js";

const sha1 = (s: string) => createHash("sha1").update(Buffer.from(s)).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(20); }
  throw new Error("condition not met");
}

type Msg = { type: string; [k: string]: unknown };
const ofType = (t: string) => (m: unknown) => (m as Msg).type === t;

async function authToken(c: TestClient): Promise<string> {
  const { nonce } = await c.nextMsg<{ nonce: string }>(ofType("challenge"));
  return createHash("sha256").update(nonce.slice(0, 16) + TEST_PASSWORD + nonce.slice(16)).digest("hex");
}

async function connect(port: number, deviceId: string): Promise<TestClient> {
  const c = connectClient(port);
  await waitForOpen(c);
  c.send({ type: "auth", deviceId, token: await authToken(c) });
  await c.nextMsg(ofType("auth_ok"));
  return c;
}

function upload(path: string, text: string, mtime: number, baseSha1?: string) {
  return {
    type: "file_data", mode: "apply",
    file: { path, sha1: sha1(text), mtime, action: "active", fileType: "file", size: text.length },
    content: Buffer.from(text).toString("base64"),
    ...(baseSha1 ? { baseSha1 } : {}),
  };
}

describe("mobile speed — handshake, liveness, priority", () => {
  it("advertises app_ping and pipelined_auth", async () => {
    const srv = await startTestServer();
    const c = await connect(srv.port, "devA");
    c.send({ type: "version_check", version: "0", build: "0" });
    const res = await c.nextMsg<Msg>(ofType("version_check_response"));
    assert.ok((res.caps as string[]).includes(APP_PING_CAP));
    assert.ok((res.caps as string[]).includes(PIPELINED_AUTH_CAP));
    c.close(); await srv.stop();
  });

  it("answers ping with pong, echoing n", async () => {
    const srv = await startTestServer();
    const c = await connect(srv.port, "devA");
    c.send({ type: "ping", n: 42 });
    const pong = await c.nextMsg<Msg>(ofType("pong"));
    assert.equal(pong.n, 42);
    c.close(); await srv.stop();
  });

  it("handles auth and version_check sent back to back (pipelined)", async () => {
    const srv = await startTestServer();
    const c = connectClient(srv.port);
    await waitForOpen(c);
    const token = await authToken(c);
    c.send({ type: "auth", deviceId: "devA", token });
    c.send({ type: "version_check", version: "0", build: "0" }); // no wait for auth_ok
    await c.nextMsg(ofType("auth_ok"));
    const res = await c.nextMsg<Msg>(ofType("version_check_response"));
    assert.ok(Array.isArray(res.caps));
    c.close(); await srv.stop();
  });

  it("a pipelined version_check after a WRONG password never gets through", async () => {
    const srv = await startTestServer();
    const c = connectClient(srv.port);
    await waitForOpen(c);
    await authToken(c);
    c.send({ type: "auth", deviceId: "devA", token: "0".repeat(64) });
    c.send({ type: "version_check", version: "0", build: "0" });
    await c.nextMsg(ofType("auth_error"));
    await assert.rejects(c.nextMsg(ofType("version_check_response"), 300));
    await srv.stop();
  });

  it("pushes the priority (open) note first, ahead of the ordered catch-up", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    a.send(upload("seed.md", "s", 1));
    await until(() => !!srv.ctx.db.getFile("seed.md"));
    const since = srv.ctx.db.getCurrentSeq();
    // Other device writes several notes; the open note is written LAST, so the
    // ordered stream would deliver it last.
    for (let i = 0; i < 5; i++) a.send(upload(`n${i}.md`, `note ${i}`, 10 + i));
    a.send(upload("open.md", "open note v2", 50));
    await until(() => !!srv.ctx.db.getFile("open.md"));

    const b = await connect(srv.port, "devB");
    b.send({ type: "sync_cursor", since, priority: ["open.md"] });
    const first = await b.nextMsg<Msg>(ofType("file_push"));
    assert.equal((first.file as { path: string }).path, "open.md", "open note first");
    assert.equal(first.session, undefined, "priority push is out-of-band (not part of the ordered stream)");
    assert.equal(typeof first.seq, "number");
    const done = await b.nextMsg<Msg>(ofType("sync_done"));
    assert.equal(done.cursor, srv.ctx.db.getCurrentSeq(), "ordered stream still completes");
    a.close(); b.close(); await srv.stop();
  });

  it("ignores priority for unchanged notes and invalid paths", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    a.send(upload("old.md", "old", 1));
    await until(() => !!srv.ctx.db.getFile("old.md"));
    const since = srv.ctx.db.getCurrentSeq();
    const b = await connect(srv.port, "devB");
    b.send({ type: "sync_cursor", since, priority: ["old.md", "../etc/passwd", "."] });
    const done = await b.nextMsg<Msg>(ofType("sync_done"));
    assert.equal(done.cursor, since);
    await assert.rejects(b.nextMsg(ofType("file_push"), 200), "nothing changed → nothing pushed");
    a.close(); b.close(); await srv.stop();
  });
});
