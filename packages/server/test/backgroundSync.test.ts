import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BACKGROUND_SYNC_PATH } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen, TEST_PASSWORD, type TestClient } from "./helpers.js";
import { BG_RATE_LIMIT, issueBgToken, resolveBgToken } from "../src/backgroundSync.js";

const sha1 = (s: string) => createHash("sha1").update(Buffer.from(s)).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(20); }
  throw new Error("condition not met");
}

type Msg = { type: string; [k: string]: unknown };

/** Authenticate and return the auth_ok message (the helper's auth() hides it). */
async function authOk(c: TestClient, deviceId: string): Promise<Msg> {
  const { nonce } = await c.nextMsg<{ nonce: string }>((m) => (m as Msg).type === "challenge");
  const token = createHash("sha256").update(nonce.slice(0, 16) + TEST_PASSWORD + nonce.slice(16)).digest("hex");
  c.send({ type: "auth", deviceId, token });
  return c.nextMsg<Msg>((m) => (m as Msg).type === "auth_ok");
}

async function connect(port: number, deviceId: string): Promise<{ c: TestClient; bgToken: string }> {
  const c = connectClient(port);
  await waitForOpen(c);
  const ok = await authOk(c, deviceId);
  assert.equal(typeof ok.bgToken, "string", "auth_ok must carry a bgToken");
  return { c, bgToken: ok.bgToken as string };
}

function entry(path: string, text: string, mtime: number, baseSha1?: string) {
  return {
    file: { path, sha1: sha1(text), mtime, action: "active", fileType: "file", size: text.length },
    content: Buffer.from(text).toString("base64"),
    ...(baseSha1 ? { baseSha1 } : {}),
  };
}

async function beacon(port: number, body: unknown): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${BACKGROUND_SYNC_PATH}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return res.status;
}

describe("background sync (sendBeacon flush)", () => {
  it("issues a token on auth and rotates it on reconnect", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    assert.equal(resolveBgToken(srv.ctx, a.bgToken), "devA");
    a.c.close();
    const a2 = await connect(srv.port, "devA");
    assert.notEqual(a2.bgToken, a.bgToken);
    assert.equal(resolveBgToken(srv.ctx, a.bgToken), null, "old token revoked on reconnect");
    assert.equal(resolveBgToken(srv.ctx, a2.bgToken), "devA");
    a2.c.close(); await srv.stop();
  });

  it("applies a beaconed edit and broadcasts it to other devices, not its author", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    const status = await beacon(srv.port, { v: 1, token: a.bgToken, files: [entry("note.md", "from the phone", 1000)] });
    assert.equal(status, 204);
    assert.equal(srv.ctx.db.getFile("note.md")?.sha1, sha1("from the phone"));
    assert.equal(srv.ctx.storage.readLatest("note.md")?.toString(), "from the phone");
    const push = await b.c.nextMsg<Msg>((m) => (m as Msg).type === "file_push");
    assert.equal((push.file as { path: string }).path, "note.md");
    // The author's still-registered socket must not get its own edit echoed back.
    await assert.rejects(a.c.nextMsg((m) => (m as Msg).type === "file_push", 400));
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("rejects a bad or missing token without writing anything", async () => {
    const srv = await startTestServer();
    assert.equal(await beacon(srv.port, { v: 1, token: "nope", files: [entry("x.md", "x", 1000)] }), 401);
    assert.equal(await beacon(srv.port, { v: 1, files: [entry("x.md", "x", 1000)] }), 401);
    assert.equal(srv.ctx.db.getFile("x.md"), undefined);
    await srv.stop();
  });

  it("never accepts deletes, folders, bad paths, or malformed bodies", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const del = entry("gone.md", "x", 1000); (del.file as { action: string }).action = "deleted";
    const folder = entry("dir", "x", 1000); (folder.file as { fileType: string }).fileType = "folder";
    const cases: unknown[] = [
      { v: 1, token: a.bgToken, files: [del] },
      { v: 1, token: a.bgToken, files: [folder] },
      { v: 1, token: a.bgToken, files: [entry(".", "root", 1000)] },
      { v: 1, token: a.bgToken, files: [entry("a/../b.md", "alias", 1000)] },
      { v: 1, token: a.bgToken, files: [entry("ok.md", "ok", 1000), del] }, // all-or-nothing
      { v: 1, token: a.bgToken, files: [] },
      "not json",
    ];
    for (const body of cases) assert.equal(await beacon(srv.port, body), 400, JSON.stringify(body));
    for (const p of ["gone.md", "dir", ".", "a/../b.md", "ok.md"]) assert.equal(srv.ctx.db.getFile(p), undefined, p);
    a.c.close(); await srv.stop();
  });

  it("a beacon duplicating an already-delivered WS upload is a silent no-op", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    const e = entry("dup.md", "same bytes", 2000);
    a.c.send({ type: "file_data", mode: "apply", ...e });
    await b.c.nextMsg<Msg>((m) => (m as Msg).type === "file_push");
    assert.equal(await beacon(srv.port, { v: 1, token: a.bgToken, files: [e] }), 204);
    await assert.rejects(b.c.nextMsg((m) => (m as Msg).type === "file_push", 400), "no second broadcast");
    assert.equal(srv.ctx.db.getVersions("dup.md").length, 1, "no duplicate version row");
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("a stale beaconed edit is preserved as a conflict, never overwriting the head", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    const v1 = entry("shared.md", "v1", 1000);
    a.c.send({ type: "file_data", mode: "apply", ...v1 });
    await until(() => srv.ctx.db.getFile("shared.md")?.sha1 === sha1("v1"));
    b.c.send({ type: "file_data", mode: "apply", ...entry("shared.md", "v2 from laptop", 3000, sha1("v1")) });
    await until(() => srv.ctx.db.getFile("shared.md")?.sha1 === sha1("v2 from laptop"));
    // The phone edited on top of v1 (a known, now-superseded version).
    const status = await beacon(srv.port, { v: 1, token: a.bgToken, files: [entry("shared.md", "phone edit", 2000, sha1("v1"))] });
    assert.equal(status, 204);
    assert.equal(srv.ctx.db.getFile("shared.md")?.sha1, sha1("v2 from laptop"), "head kept");
    const conflicts = srv.ctx.db.listConflicts();
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.path, "shared.md");
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("rate-limits a runaway device", async () => {
    const srv = await startTestServer();
    const token = issueBgToken(srv.ctx, "devA");
    let last = 0;
    for (let i = 0; i <= BG_RATE_LIMIT; i++) {
      last = await beacon(srv.port, { v: 1, token, files: [entry(`r${i}.md`, `n${i}`, 1000 + i)] });
    }
    assert.equal(last, 429);
    await srv.stop();
  });

  it("rejects an expired token", async () => {
    const srv = await startTestServer();
    const token = issueBgToken(srv.ctx, "devA", Date.now() - 48 * 60 * 60 * 1000);
    assert.equal(resolveBgToken(srv.ctx, token), null);
    assert.equal(await beacon(srv.port, { v: 1, token, files: [entry("late.md", "x", 1000)] }), 401);
    await srv.stop();
  });
});
