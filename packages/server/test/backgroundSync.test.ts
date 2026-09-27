import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BACKGROUND_SYNC_PATH } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen, TEST_PASSWORD, type TestClient } from "./helpers.js";
import { BG_AUTH_FAIL_LIMIT, BG_RATE_LIMIT, issueBgToken, resolveBgToken, revokeBgTokens } from "../src/backgroundSync.js";
import { readHead } from "../src/head.js";

const sha1 = (s: string) => createHash("sha1").update(Buffer.from(s)).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(20); }
  throw new Error("condition not met");
}

type Msg = { type: string; [k: string]: unknown };
const isPush = (path: string) => (m: unknown) =>
  (m as Msg).type === "file_push" && ((m as Msg).file as { path: string }).path === path;

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

/** Upload over the WS and wait until the server head reflects it. */
async function wsUpload(srv: { ctx: { db: { getFile(p: string): { sha1: string } | undefined } } }, c: TestClient, e: ReturnType<typeof entry>) {
  c.send({ type: "file_data", mode: "apply", ...e });
  await until(() => srv.ctx.db.getFile(e.file.path)?.sha1 === e.file.sha1);
}

async function beacon(port: number, body: unknown): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${BACKGROUND_SYNC_PATH}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return res.status;
}

describe("background sync — beacon endpoint", () => {
  it("issues a token on auth, rotates it on reconnect, revokes it on device removal", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    assert.equal(resolveBgToken(srv.ctx, a.bgToken), "devA");
    a.c.close();
    const a2 = await connect(srv.port, "devA");
    assert.notEqual(a2.bgToken, a.bgToken);
    assert.equal(resolveBgToken(srv.ctx, a.bgToken), null, "old token revoked on reconnect");
    revokeBgTokens(srv.ctx, "devA");
    assert.equal(resolveBgToken(srv.ctx, a2.bgToken), null, "revoked on removal");
    a2.c.close(); await srv.stop();
  });

  it("fast-forwards a beaconed edit and broadcasts it to other devices, not its author", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    await wsUpload(srv, a.c, entry("note.md", "v1", 1000));
    await b.c.nextMsg(isPush("note.md"));
    const status = await beacon(srv.port, { v: 1, token: a.bgToken, files: [entry("note.md", "from the phone", 2000, sha1("v1"))] });
    assert.equal(status, 204);
    assert.equal(srv.ctx.db.getFile("note.md")?.sha1, sha1("from the phone"));
    assert.equal(srv.ctx.storage.readLatest("note.md")?.toString(), "from the phone");
    await b.c.nextMsg(isPush("note.md"));
    await assert.rejects(a.c.nextMsg(isPush("note.md"), 400), "no echo to the author");
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("creates a brand-new file by beacon", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    assert.equal(await beacon(srv.port, { v: 1, token: a.bgToken, files: [entry("new.md", "fresh", 1000)] }), 204);
    assert.equal(srv.ctx.db.getFile("new.md")?.sha1, sha1("fresh"));
    a.c.close(); await srv.stop();
  });

  it("defers (never resolves) divergence: stale base, deleted head, already-landed bytes", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    // Head moved on under the phone: stale base → deferred, head kept, no conflict.
    await wsUpload(srv, a.c, entry("shared.md", "v1", 1000));
    await wsUpload(srv, b.c, entry("shared.md", "v2 from laptop", 3000, sha1("v1")));
    // Deleted elsewhere → a beacon must never resurrect it.
    await wsUpload(srv, a.c, entry("gone.md", "doomed", 1000));
    b.c.send({ type: "file_data", mode: "apply", file: { path: "gone.md", sha1: sha1("doomed"), mtime: 4000, action: "deleted", fileType: "file" }, content: "" });
    await until(() => srv.ctx.db.getFile("gone.md")?.action === "deleted");
    // Already landed over the WS → deferred, no second version.
    await wsUpload(srv, a.c, entry("dup.md", "same bytes", 2000));

    const status = await beacon(srv.port, {
      v: 1, token: a.bgToken, files: [
        entry("shared.md", "phone edit", 2000, sha1("v1")),
        entry("gone.md", "phone edit of doomed", 5000, sha1("doomed")),
        entry("dup.md", "same bytes", 2000),
      ],
    });
    assert.equal(status, 204);
    assert.equal(srv.ctx.db.getFile("shared.md")?.sha1, sha1("v2 from laptop"), "head kept");
    assert.equal(srv.ctx.db.getFile("gone.md")?.action, "deleted", "not resurrected");
    assert.equal(srv.ctx.db.getVersions("dup.md").length, 1, "no duplicate version row");
    assert.equal(srv.ctx.db.listConflicts().length, 0, "a beacon never mints a conflict");
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("a beacon racing ahead of its own buffered WS upload is deferred, so no self-conflict", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    await wsUpload(srv, a.c, entry("typing.md", "base", 1000));
    // v_b was built on v_a, which is still in flight on the WS → base isn't the head.
    assert.equal(await beacon(srv.port, { v: 1, token: a.bgToken, files: [entry("typing.md", "v_b", 3000, sha1("v_a"))] }), 204);
    assert.equal(srv.ctx.db.getFile("typing.md")?.sha1, sha1("base"));
    // Then the WS delivers v_a and v_b in order: clean fast-forwards.
    await wsUpload(srv, a.c, entry("typing.md", "v_a", 2000, sha1("base")));
    await wsUpload(srv, a.c, entry("typing.md", "v_b", 3000, sha1("v_a")));
    assert.equal(srv.ctx.db.listConflicts().length, 0);
    a.c.close(); await srv.stop();
  });

  it("rejects bad tokens, deletes, folders, bad paths and malformed bodies without writing", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    assert.equal(await beacon(srv.port, { v: 1, token: "nope", files: [entry("x.md", "x", 1000)] }), 401);
    assert.equal(await beacon(srv.port, { v: 1, files: [entry("x.md", "x", 1000)] }), 401);
    const del = entry("gone.md", "x", 1000); (del.file as { action: string }).action = "deleted";
    const folder = entry("dir", "x", 1000); (folder.file as { fileType: string }).fileType = "folder";
    const emptySha = entry("e.md", "x", 1000); (emptySha.file as { sha1: string }).sha1 = "";
    const cases: unknown[] = [
      { v: 1, token: a.bgToken, files: [del] },
      { v: 1, token: a.bgToken, files: [folder] },
      { v: 1, token: a.bgToken, files: [emptySha] },
      { v: 1, token: a.bgToken, files: [entry(".", "root", 1000)] },
      { v: 1, token: a.bgToken, files: [entry("a/../b.md", "alias", 1000)] },
      { v: 1, token: a.bgToken, files: [entry("ok.md", "ok", 1000), del] }, // all-or-nothing
      { v: 1, token: a.bgToken, files: [] },
      "not json",
    ];
    for (const body of cases) assert.equal(await beacon(srv.port, body), 400, JSON.stringify(body));
    for (const p of ["x.md", "gone.md", "dir", "e.md", ".", "a/../b.md", "ok.md"]) assert.equal(srv.ctx.db.getFile(p), undefined, p);
    a.c.close(); await srv.stop();
  });

  it("rate-limits a runaway device and a client spamming bad tokens", async () => {
    const srv = await startTestServer();
    const token = issueBgToken(srv.ctx, "devA");
    let last = 0;
    for (let i = 0; i <= BG_RATE_LIMIT; i++) {
      last = await beacon(srv.port, { v: 1, token, files: [entry(`r${i}.md`, `n${i}`, 1000 + i)] });
    }
    assert.equal(last, 429);
    for (let i = 0; i < BG_AUTH_FAIL_LIMIT; i++) await beacon(srv.port, { v: 1, token: `bad${i}`, files: [] });
    assert.equal(await beacon(srv.port, { v: 1, token: "bad-again", files: [] }), 429);
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

describe("background sync — WS resend (reconnect replay) semantics", () => {
  it("advertises the resend capability", async () => {
    const srv = await startTestServer();
    const c = connectClient(srv.port); await waitForOpen(c); await authOk(c, "devA");
    c.send({ type: "version_check", version: "0", build: "0" });
    const res = await c.nextMsg<Msg>((m) => (m as Msg).type === "version_check_response");
    assert.ok((res.caps as string[]).includes("bg_resend"));
    c.close(); await srv.stop();
  });

  it("a resend of bytes that landed and were then superseded is dropped: no conflict", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    await wsUpload(srv, a.c, entry("n.md", "phone edit", 1000));
    await wsUpload(srv, b.c, entry("n.md", "laptop edit", 3000, sha1("phone edit")));
    // Drain the broadcast of the laptop edit so only a reply to the resend counts.
    await a.c.nextMsg<Msg>(isPush("n.md"));
    // Phone reopens and replays its (already-delivered) edit, base = its own sha.
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...entry("n.md", "phone edit", 1000, sha1("phone edit")) });
    await assert.rejects(a.c.nextMsg<Msg>(isPush("n.md"), 400), "dropped silently: no push");
    assert.equal(srv.ctx.db.getFile("n.md")?.sha1, sha1("laptop edit"));
    assert.equal(srv.ctx.db.listConflicts().length, 0, "no spurious conflict");
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("a resend never resurrects a note another device deleted", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    await wsUpload(srv, a.c, entry("A.md", "phone edit", 1000));
    b.c.send({ type: "file_data", mode: "apply", file: { path: "A.md", sha1: sha1("phone edit"), mtime: 2000, action: "deleted", fileType: "file" }, content: "" });
    await until(() => srv.ctx.db.getFile("A.md")?.action === "deleted");
    await a.c.nextMsg<Msg>(isPush("A.md")); // the delete's own broadcast
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...entry("A.md", "phone edit", 1000, sha1("phone edit")) });
    await assert.rejects(a.c.nextMsg<Msg>(isPush("A.md"), 400), "dropped silently: no push");
    assert.equal(srv.ctx.db.getFile("A.md")?.action, "deleted", "stays deleted");
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("recognises a landed upload even after version cleanup and tombstone purge removed every trace", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    await wsUpload(srv, a.c, entry("T.md", "base", 500));
    await wsUpload(srv, a.c, entry("T.md", "phone S", 1000, sha1("base")));
    // The laptop keeps editing; cleanup then trims every non-head version row.
    let prev = "phone S";
    for (let i = 1; i <= 6; i++) {
      const next = `laptop ${i}`;
      await wsUpload(srv, b.c, entry("T.md", next, 2000 + i, sha1(prev)));
      prev = next;
    }
    for (const row of srv.ctx.db.getVersionRowsToTrim("T.md", 0)) srv.ctx.db.deleteVersionRowById(row.id);
    assert.equal(srv.ctx.db.hasVersionSha("T.md", sha1("phone S")), false, "precondition: S's row is gone");

    // Replay of S (base = "base", also trimmed): already landed → no conflict.
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...entry("T.md", "phone S", 1000, sha1("base")) });
    await wsUpload(srv, a.c, entry("probe1.md", "p", 1)); // ordered behind the resend
    assert.equal(srv.ctx.db.getFile("T.md")?.sha1, sha1(prev), "head kept");
    assert.equal(srv.ctx.db.listConflicts().length, 0, "no spurious conflict");

    // Deleted on the laptop, tombstone purged: the replay still must not resurrect it.
    b.c.send({ type: "file_data", mode: "apply", file: { path: "T.md", sha1: sha1(prev), mtime: 3000, action: "deleted", fileType: "file" }, content: "" });
    await until(() => srv.ctx.db.getFile("T.md")?.action === "deleted");
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...entry("T.md", "phone S", 1000, sha1("base")) });
    await wsUpload(srv, a.c, entry("probe2.md", "p", 1));
    assert.equal(srv.ctx.db.getFile("T.md")?.action, "deleted", "not resurrected");
    srv.ctx.db.deleteFileMeta("T.md");
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...entry("T.md", "phone S", 1000, sha1("base")) });
    await wsUpload(srv, a.c, entry("probe3.md", "p", 1));
    assert.ok(!srv.ctx.db.getFile("T.md"), "not resurrected after purge either");
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("an E2EE resend of an OLDER ciphertext version never downgrades a re-keyed head", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const blob = (v: number, fill: number) =>
      Buffer.concat([Buffer.from(`IONENCv${v}`), Buffer.alloc(12, fill), Buffer.alloc(32, fill + 1)]);
    const plainSha = sha1("secret");
    const up = (buf: Buffer, mtime: number, resend: boolean) => ({
      type: "file_data", mode: "apply", ...(resend ? { resend: true } : {}),
      file: { path: "d.md", sha1: plainSha, mtime, action: "active", fileType: "file", size: buf.length },
      content: buf.toString("base64"), baseSha1: plainSha,
    });
    a.c.send(up(blob(3, 7), 2000, false)); // re-keyed head (v3)
    await until(() => readHead(srv.ctx, "d.md")?.[7] === 0x33);
    a.c.send(up(blob(2, 1), 1000, true)); // stale v2 replay from an old device
    await wsUpload(srv, a.c, entry("probe.md", "p", 1));
    assert.equal(readHead(srv.ctx, "d.md")?.[7], 0x33, "head stays v3");
    a.c.close(); await srv.stop();
  });

  it("a resend of a note recreated since (same content, new mtime) is re-added, not dropped", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    await wsUpload(srv, a.c, entry("R.md", "same words", 1000));
    b.c.send({ type: "file_data", mode: "apply", file: { path: "R.md", sha1: sha1("same words"), mtime: 2000, action: "deleted", fileType: "file" }, content: "" });
    await until(() => srv.ctx.db.getFile("R.md")?.action === "deleted");
    // Restored from trash on the phone (new mtime), then frozen mid-send.
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...entry("R.md", "same words", 5000, sha1("same words")) });
    await until(() => srv.ctx.db.getFile("R.md")?.action === "active");
    assert.equal(srv.ctx.db.getFile("R.md")?.sha1, sha1("same words"));
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("an E2EE re-key resend (same plaintext sha, new ciphertext version) is stored, not dropped", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const blob = (v: number, fill: number) =>
      Buffer.concat([Buffer.from(`IONENCv${v}`), Buffer.alloc(12, fill), Buffer.alloc(32, fill + 1)]);
    const plainSha = sha1("secret note");
    const up = (buf: Buffer, resend: boolean) => ({
      type: "file_data", mode: "apply", ...(resend ? { resend: true } : {}),
      file: { path: "e.md", sha1: plainSha, mtime: 1000, action: "active", fileType: "file", size: buf.length },
      content: buf.toString("base64"), baseSha1: plainSha,
    });
    a.c.send(up(blob(2, 1), false));
    await until(() => srv.ctx.db.getFile("e.md")?.sha1 === plainSha);
    // Same bytes again as a resend: already landed → dropped, head untouched.
    a.c.send(up(blob(2, 1), true));
    // Re-key to v3 (e.g. frozen during "Re-encrypt all files"), replayed as a resend.
    a.c.send(up(blob(3, 5), true));
    await until(() => readHead(srv.ctx, "e.md")?.[7] === 0x33);
    assert.equal(srv.ctx.db.getFile("e.md")?.sha1, plainSha);
    a.c.close(); await srv.stop();
  });

  it("falls back to the burst's origin base when the recorded base never landed", async () => {
    // Phone: v1 synced; then v2 (base v1) and v3 (base v2) both lost in the
    // freeze. Meanwhile the laptop edited v1 → L — with a clock BEHIND the
    // phone's, so recency alone would let the phone's v3 silently win.
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    await wsUpload(srv, a.c, entry("o.md", "v1", 1000));
    await wsUpload(srv, b.c, entry("o.md", "laptop L", 1500, sha1("v1")));
    a.c.send({ type: "file_data", mode: "apply", resend: true, originBaseSha1: sha1("v1"), ...entry("o.md", "v3", 3000, sha1("v2")) });
    await until(() => srv.ctx.db.listConflicts().length >= 1);
    assert.equal(srv.ctx.db.getFile("o.md")?.sha1, sha1("laptop L"), "the laptop's edit is not overwritten");
    assert.equal(srv.ctx.db.listConflicts()[0]!.sha1, sha1("v3"), "the phone's edit is preserved as a conflict");
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("keeps the recorded base when it did land (earlier send arrived, later one lost)", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    await wsUpload(srv, a.c, entry("f.md", "v1", 1000));
    await wsUpload(srv, a.c, entry("f.md", "v2", 2000, sha1("v1"))); // landed
    // v3 (base v2) was lost; its burst began at v1.
    a.c.send({ type: "file_data", mode: "apply", resend: true, originBaseSha1: sha1("v1"), ...entry("f.md", "v3", 3000, sha1("v2")) });
    await until(() => srv.ctx.db.getFile("f.md")?.sha1 === sha1("v3"));
    assert.equal(srv.ctx.db.listConflicts().length, 0, "a fast-forward, not a conflict");
    a.c.close(); await srv.stop();
  });

  it("a resend of genuinely lost bytes lands (fast-forward on the true base)", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    await wsUpload(srv, a.c, entry("lost.md", "v1", 1000));
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...entry("lost.md", "stranded edit", 2000, sha1("v1")) });
    await until(() => srv.ctx.db.getFile("lost.md")?.sha1 === sha1("stranded edit"));
    a.c.close(); await srv.stop();
  });

  it("a lost edit that raced a newer remote edit becomes ONE conflict, however many times it arrives", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    const b = await connect(srv.port, "devB");
    await wsUpload(srv, a.c, entry("race.md", "v1", 1000));
    await wsUpload(srv, b.c, entry("race.md", "laptop v2", 3000, sha1("v1")));
    const stranded = entry("race.md", "phone v2", 2000, sha1("v1"));
    a.c.send({ type: "file_data", mode: "apply", ...stranded });              // late WS delivery
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...stranded }); // reconnect replay
    a.c.send({ type: "file_data", mode: "apply", resend: true, ...stranded }); // replay again
    await until(() => srv.ctx.db.listConflicts().length >= 1);
    await wait(150);
    assert.equal(srv.ctx.db.getFile("race.md")?.sha1, sha1("laptop v2"), "head kept");
    const conflicts = srv.ctx.db.listConflicts();
    assert.equal(conflicts.length, 1, "preserved exactly once");
    assert.equal(conflicts[0]!.sha1, sha1("phone v2"));
    a.c.close(); b.c.close(); await srv.stop();
  });

  it("rejects an active-file upload with an empty sha1 instead of corrupting the head", async () => {
    const srv = await startTestServer();
    const a = await connect(srv.port, "devA");
    await wsUpload(srv, a.c, entry("keep.md", "real", 1000));
    a.c.send({ type: "file_data", mode: "apply", file: { path: "keep.md", sha1: "", mtime: 2000, action: "active", fileType: "file" }, content: "", baseSha1: sha1("real") });
    await wsUpload(srv, a.c, entry("probe.md", "after", 1000)); // ordered behind the bad upload
    assert.equal(srv.ctx.db.getFile("keep.md")?.sha1, sha1("real"));
    a.c.close(); await srv.stop();
  });
});
