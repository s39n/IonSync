import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { FileEntry } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen, TEST_PASSWORD } from "./helpers.js";

describe("auth", () => {
  it("rejects an incorrect password", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);

    const challenge = await client.nextMsg<{ type: string; nonce: string }>(
      (m) => (m as { type: string }).type === "challenge"
    );
    assert.equal(challenge.type, "challenge");

    client.send({ type: "auth", deviceId: "bad-device", token: "wrong" });

    const resp = await client.nextMsg<{ type: string }>(
      (m) => (m as { type: string }).type === "auth_error"
    );
    assert.equal(resp.type, "auth_error");

    client.close();
    await srv.stop();
  });

  it("accepts a correct password and records the device", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);

    await client.auth("my-device");

    const devices = srv.ctx.db.getDevices();
    assert.ok(devices.some((d) => d.id === "my-device"));

    client.close();
    await srv.stop();
  });
});

describe("sync", () => {
  it("sends sync_done immediately when both sides have no files", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "sync", files: [] });

    const done = await client.nextMsg<{ type: string }>(
      (m) => (m as { type: string }).type === "sync_done"
    );
    assert.equal(done.type, "sync_done");

    client.close();
    await srv.stop();
  });

  it("requests upload when client has a file server doesn't know about", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    const file: FileEntry = {
      path: "notes/hello.md",
      sha1: "aabbcc",
      mtime: 1_000_000,
      action: "active",
      fileType: "file",
    };
    client.send({ type: "sync", files: [file] });

    const result = await client.nextMsg<{ type: string; path: string; result: string }>(
      (m) => (m as { type: string }).type === "file_event_result"
    );
    assert.equal(result.result, "client_newer");
    assert.equal(result.path, "notes/hello.md");

    client.close();
    await srv.stop();
  });

  it("full upload → sync_done cycle", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    const file: FileEntry = {
      path: "notes/hello.md",
      sha1: "0ea0f28b0c42d6bef7d0c7ab4886324feaa8b5e1",
      mtime: 1_000_000,
      action: "active",
      fileType: "file",
    };
    const content = Buffer.from("# Hello world").toString("base64");

    client.send({ type: "sync", files: [file] });
    await client.nextMsg((m) => (m as { type: string }).type === "file_event_result");

    client.send({ type: "file_data", mode: "apply", file, content });

    const done = await client.nextMsg<{ type: string }>(
      (m) => (m as { type: string }).type === "sync_done"
    );
    assert.equal(done.type, "sync_done");

    const stored = srv.ctx.db.getFile("notes/hello.md");
    assert.equal(stored?.sha1, "0ea0f28b0c42d6bef7d0c7ab4886324feaa8b5e1");
    assert.equal(stored?.action, "active");

    client.close();
    await srv.stop();
  });

  it("pushes server-side files to a client that doesn't have them", async () => {
    const srv = await startTestServer();

    const file: FileEntry = {
      path: "notes/server-only.md",
      sha1: "da9c7108dfa05de60f74b0887da4485d7654af07",
      mtime: 2_000_000,
      action: "active",
      fileType: "file",
    };
    srv.ctx.db.upsertFile(file);
    srv.ctx.storage.write(file.path, file.mtime, Buffer.from("server content"));

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "sync", files: [] });

    const push = await client.nextMsg<{ type: string; file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_push"
    );
    assert.equal(push.file.path, "notes/server-only.md");
    assert.equal(Buffer.from(push.content, "base64").toString(), "server content");

    client.close();
    await srv.stop();
  });

  it("server wins when its file is newer", async () => {
    const srv = await startTestServer();
    const filePath = "notes/conflict.md";

    const serverFile: FileEntry = {
      path: filePath, sha1: "59788dcb296703167ffdd64ba07113643968a2f2", mtime: 2_000_000, action: "active", fileType: "file",
    };
    srv.ctx.db.upsertFile(serverFile);
    srv.ctx.storage.write(filePath, serverFile.mtime, Buffer.from("server wins"));

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    const clientFile: FileEntry = {
      path: filePath, sha1: "client-sha", mtime: 1_000_000, action: "active", fileType: "file",
    };
    client.send({ type: "sync", files: [clientFile] });

    const push = await client.nextMsg<{ type: string; file: FileEntry }>(
      (m) => (m as { type: string }).type === "file_push"
    );
    assert.equal(push.file.sha1, "59788dcb296703167ffdd64ba07113643968a2f2");

    client.close();
    await srv.stop();
  });

  it("broadcasts a delete to other connected peers", async () => {
    const srv = await startTestServer();
    const filePath = "notes/to-delete.md";

    const activeFile: FileEntry = {
      path: filePath, sha1: "040f06fd774092478d450774f5ba30c5da78acc8", mtime: 1_000_000, action: "active", fileType: "file",
    };
    srv.ctx.db.upsertFile(activeFile);
    srv.ctx.storage.write(filePath, activeFile.mtime, Buffer.from("content"));

    // Connect device-1 (will perform the delete)
    const client1 = connectClient(srv.port);
    await waitForOpen(client1);
    await client1.auth("device-1");

    // Connect device-2 (should receive the broadcast)
    const client2 = connectClient(srv.port);
    await waitForOpen(client2);
    await client2.auth("device-2");

    // client1: sync and upload delete
    const deletedFile: FileEntry = {
      path: filePath, sha1: "040f06fd774092478d450774f5ba30c5da78acc8", mtime: 1_500_000, action: "deleted", fileType: "file",
    };
    client1.send({ type: "sync", files: [deletedFile] });
    await client1.nextMsg((m) => (m as { type: string }).type === "file_event_result");
    client1.send({ type: "file_data", mode: "apply", file: deletedFile, content: "" });
    await client1.nextMsg((m) => (m as { type: string }).type === "sync_done");

    // client2 should receive a broadcast of the delete
    const broadcast = await client2.nextMsg<{ type: string; file: FileEntry }>(
      (m) =>
        (m as { type: string }).type === "file_push" &&
        (m as { file: FileEntry }).file.action === "deleted",
      8_000
    );
    assert.equal(broadcast.file.action, "deleted");

    const stored = srv.ctx.db.getFile(filePath);
    assert.equal(stored?.action, "deleted");

    client1.close();
    client2.close();
    await srv.stop();
  });
});

describe("file_data download", () => {
  it("serves a file on mode:send request", async () => {
    const srv = await startTestServer();
    const filePath = "notes/download-me.md";

    const file: FileEntry = {
      path: filePath, sha1: "25ba9463966949dfc7c7455ccaf9fa51ee7c6600", mtime: 3_000_000, action: "active", fileType: "file",
    };
    srv.ctx.db.upsertFile(file);
    srv.ctx.storage.write(filePath, file.mtime, Buffer.from("downloadable content"));

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "file_data", mode: "send", path: filePath });

    const resp = await client.nextMsg<{ type: string; file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_data_response"
    );
    assert.equal(resp.file.path, filePath);
    assert.equal(Buffer.from(resp.content, "base64").toString(), "downloadable content");

    client.close();
    await srv.stop();
  });
});

describe("file_history", () => {
  it("returns version list for a file", async () => {
    const srv = await startTestServer();
    const filePath = "notes/versioned.md";

    const v1: FileEntry = { path: filePath, sha1: "sha-v1", mtime: 1000, action: "active", fileType: "file" };
    const v2: FileEntry = { path: filePath, sha1: "sha-v2", mtime: 2000, action: "active", fileType: "file" };
    srv.ctx.db.upsertFile(v1);
    srv.ctx.storage.write(filePath, v1.mtime, Buffer.from("version 1"));
    srv.ctx.db.upsertFile(v2);
    srv.ctx.storage.write(filePath, v2.mtime, Buffer.from("version 2"));

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "file_history", path: filePath });

    const resp = await client.nextMsg<{ type: string; path: string; versions: unknown[] }>(
      (m) => (m as { type: string }).type === "file_history_response"
    );
    assert.equal(resp.path, filePath);
    assert.equal(resp.versions.length, 2);

    client.close();
    await srv.stop();
  });
});

describe("conflict resolution (baseSha1)", () => {
  // Real SHA1s — handleFileUpload verifies content hashes.
  const PATH = "notes/conflict.md";
  const V1 = { sha1: "7bd81a159ea42d0f32dc1bcac2b3756123a985c7", b64: Buffer.from("v one").toString("base64") };
  const V2 = { sha1: "c4fe9a596a0f41e1a3afde544869302fc0e5a947", b64: Buffer.from("v two").toString("base64") };
  const V3 = { sha1: "850f94f51670998edcd47f2ced22e23e8ac4a4ae", b64: Buffer.from("v three").toString("base64") };

  function entry(sha1: string, mtime: number): FileEntry {
    return { path: PATH, sha1, mtime, action: "active", fileType: "file" };
  }

  /** file_history round-trip — guarantees the previous upload was processed. */
  async function settle(client: { send(m: unknown): void; nextMsg<T>(p?: (m: unknown) => boolean): Promise<T> }) {
    client.send({ type: "file_history", path: PATH });
    await client.nextMsg((m) => (m as { type: string }).type === "file_history_response");
  }

  it("accepts a fast-forward upload (baseSha1 matches server head)", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 1000), content: V1.b64 });
    await settle(client);
    client.send({ type: "file_data", mode: "apply", file: entry(V2.sha1, 2000), content: V2.b64, baseSha1: V1.sha1 });
    await settle(client);

    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V2.sha1);
    assert.ok(!srv.ctx.db.getAllFiles().some((f) => f.path.includes("(Conflicted Copy")));

    client.close();
    await srv.stop();
  });

  it("diverts a stale-base upload to a conflicted copy and keeps the server head", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 1000), content: V1.b64 });
    await settle(client);
    client.send({ type: "file_data", mode: "apply", file: entry(V2.sha1, 2000), content: V2.b64, baseSha1: V1.sha1 });
    await settle(client);

    // Concurrent edit: based on V1 even though head is V2.
    client.send({ type: "file_data", mode: "apply", file: entry(V3.sha1, 3000), content: V3.b64, baseSha1: V1.sha1 });

    const result = await client.nextMsg<{ type: string; path: string; result: string }>(
      (m) => (m as { type: string }).type === "file_event_result" && (m as { path: string }).path === PATH
    );
    assert.equal(result.result, "conflict");

    // The server re-pushes its head so the uploader converges.
    const headPush = await client.nextMsg<{ type: string; file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_push" &&
             (m as { file: FileEntry }).file.path === PATH
    );
    assert.equal(headPush.content, V2.b64);

    // Server head untouched; NO copy file — the losing edit (V3) is kept as a
    // reviewable conflict record instead.
    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V2.sha1);
    assert.ok(!srv.ctx.db.getAllFiles().some((f) => f.path.includes("(Conflicted Copy")));
    const cs = srv.ctx.db.listConflicts();
    assert.equal(cs.length, 1);
    assert.equal(cs[0]!.path, PATH);
    assert.equal(cs[0]!.sha1, V3.sha1);
    assert.equal(srv.ctx.storage.readLatest(`_conflicts/${cs[0]!.id}`)?.toString("base64"), V3.b64);

    client.close();
    await srv.stop();
  });

  it("accepts uploads without baseSha1 (legacy clients, LWW)", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 1000), content: V1.b64 });
    await settle(client);
    client.send({ type: "file_data", mode: "apply", file: entry(V2.sha1, 2000), content: V2.b64 });
    await settle(client);

    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V2.sha1);
    assert.ok(!srv.ctx.db.getAllFiles().some((f) => f.path.includes("(Conflicted Copy")));

    client.close();
    await srv.stop();
  });

  it("unknown base falls back to LWW: newer mtime accepted, older conflicts", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    const unknownBase = "0123456789abcdef0123456789abcdef01234567";

    client.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 5000), content: V1.b64 });
    await settle(client);

    // Newer mtime + unknown base (e.g. lost-upload retry) → accepted.
    client.send({ type: "file_data", mode: "apply", file: entry(V2.sha1, 6000), content: V2.b64, baseSha1: unknownBase });
    await settle(client);
    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V2.sha1);

    // Older mtime + unknown base (e.g. restored stale backup) → conflict.
    client.send({ type: "file_data", mode: "apply", file: entry(V3.sha1, 1000), content: V3.b64, baseSha1: unknownBase });
    const result = await client.nextMsg<{ type: string; path: string; result: string }>(
      (m) => (m as { type: string }).type === "file_event_result" && (m as { path: string }).path === PATH
    );
    assert.equal(result.result, "conflict");
    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V2.sha1);

    client.close();
    await srv.stop();
  });
});

describe("conflict copies for binary paths", () => {
  it("records a conflict for a binary path (no copy file)", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    const PATH = "assets.v2/photo.png";
    const V1 = { sha1: "7bd81a159ea42d0f32dc1bcac2b3756123a985c7", b64: Buffer.from("v one").toString("base64") };
    const V2 = { sha1: "c4fe9a596a0f41e1a3afde544869302fc0e5a947", b64: Buffer.from("v two").toString("base64") };
    const V3 = { sha1: "850f94f51670998edcd47f2ced22e23e8ac4a4ae", b64: Buffer.from("v three").toString("base64") };
    const entry = (sha1: string, mtime: number): FileEntry =>
      ({ path: PATH, sha1, mtime, action: "active", fileType: "file" });

    client.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 1000), content: V1.b64 });
    client.send({ type: "file_history", path: PATH });
    await client.nextMsg((m) => (m as { type: string }).type === "file_history_response");
    client.send({ type: "file_data", mode: "apply", file: entry(V2.sha1, 2000), content: V2.b64, baseSha1: V1.sha1 });
    client.send({ type: "file_history", path: PATH });
    await client.nextMsg((m) => (m as { type: string }).type === "file_history_response");

    // Stale base → conflict; the losing edit is recorded against the original
    // binary path (no copy file is created).
    client.send({ type: "file_data", mode: "apply", file: entry(V3.sha1, 3000), content: V3.b64, baseSha1: V1.sha1 });
    const result = await client.nextMsg<{ type: string; path: string; result: string }>(
      (m) => (m as { type: string }).type === "file_event_result" && (m as { path: string }).path === PATH
    );
    assert.equal(result.result, "conflict");
    assert.ok(!srv.ctx.db.getAllFiles().some((f) => f.path.includes("(Conflicted Copy")));
    const cs = srv.ctx.db.listConflicts();
    assert.equal(cs.length, 1);
    assert.equal(cs[0]!.path, PATH);
    assert.equal(cs[0]!.sha1, V3.sha1);
    assert.equal(srv.ctx.storage.readLatest(`_conflicts/${cs[0]!.id}`)?.toString("base64"), V3.b64);

    client.close();
    await srv.stop();
  });
});

describe("config/hidden path conflicts (no copies, LWW)", () => {
  const V1 = { sha1: "7bd81a159ea42d0f32dc1bcac2b3756123a985c7", b64: Buffer.from("v one").toString("base64") };
  const V2 = { sha1: "c4fe9a596a0f41e1a3afde544869302fc0e5a947", b64: Buffer.from("v two").toString("base64") };
  const V3 = { sha1: "850f94f51670998edcd47f2ced22e23e8ac4a4ae", b64: Buffer.from("v three").toString("base64") };

  function mk(path: string, sha1: string, mtime: number): FileEntry {
    return { path, sha1, mtime, action: "active", fileType: "file" };
  }
  async function settle(client: { send(m: unknown): void; nextMsg<T>(p?: (m: unknown) => boolean): Promise<T> }, path: string) {
    client.send({ type: "file_history", path });
    await client.nextMsg((m) => (m as { type: string }).type === "file_history_response");
  }

  it("stale .obsidian upload is dropped without minting a copy; head re-pushed", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    const PATH = ".obsidian/appearance.json";
    client.send({ type: "file_data", mode: "apply", file: mk(PATH, V1.sha1, 1000), content: V1.b64 });
    await settle(client, PATH);
    client.send({ type: "file_data", mode: "apply", file: mk(PATH, V2.sha1, 5000), content: V2.b64, baseSha1: V1.sha1 });
    await settle(client, PATH);

    // Stale base AND older mtime → silently dropped, head pushed back.
    client.send({ type: "file_data", mode: "apply", file: mk(PATH, V3.sha1, 2000), content: V3.b64, baseSha1: V1.sha1 });
    const headPush = await client.nextMsg<{ type: string; file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_push" && (m as { file: FileEntry }).file.path === PATH
    );
    assert.equal(headPush.content, V2.b64);
    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V2.sha1);
    assert.ok(!srv.ctx.db.getAllFiles().some((f) => f.path.includes("(Conflicted Copy")));

    client.close();
    await srv.stop();
  });

  it("newer .obsidian upload wins by LWW even from a stale base (no copy)", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    const PATH = ".obsidian/community-plugins.json";
    client.send({ type: "file_data", mode: "apply", file: mk(PATH, V1.sha1, 1000), content: V1.b64 });
    await settle(client, PATH);
    client.send({ type: "file_data", mode: "apply", file: mk(PATH, V2.sha1, 2000), content: V2.b64, baseSha1: V1.sha1 });
    await settle(client, PATH);

    client.send({ type: "file_data", mode: "apply", file: mk(PATH, V3.sha1, 3000), content: V3.b64, baseSha1: V1.sha1 });
    await settle(client, PATH);

    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V3.sha1);
    assert.ok(!srv.ctx.db.getAllFiles().some((f) => f.path.includes("(Conflicted Copy")));

    client.close();
    await srv.stop();
  });

  it("unknown base with EQUAL mtime is accepted (E2EE re-encrypt pattern)", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    const PATH = "notes/equal-mtime.md";
    client.send({ type: "file_data", mode: "apply", file: mk(PATH, V1.sha1, 4000), content: V1.b64 });
    await settle(client, PATH);

    const unknownBase = "0123456789abcdef0123456789abcdef01234567";
    client.send({ type: "file_data", mode: "apply", file: mk(PATH, V2.sha1, 4000), content: V2.b64, baseSha1: unknownBase });
    await settle(client, PATH);

    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V2.sha1);
    assert.ok(!srv.ctx.db.getAllFiles().some((f) => f.path.includes("(Conflicted Copy")));

    client.close();
    await srv.stop();
  });
});

describe("no-op resend suppression (echo storm)", () => {
  const PATH = "notes/echo.md";
  const V1 = { sha1: "7bd81a159ea42d0f32dc1bcac2b3756123a985c7", b64: Buffer.from("v one").toString("base64") };
  const V2 = { sha1: "c4fe9a596a0f41e1a3afde544869302fc0e5a947", b64: Buffer.from("v two").toString("base64") };

  function entry(sha1: string, mtime: number): FileEntry {
    return { path: PATH, sha1, mtime, action: "active", fileType: "file" };
  }
  async function settle(client: { send(m: unknown): void; nextMsg<T>(p?: (m: unknown) => boolean): Promise<T> }) {
    client.send({ type: "file_history", path: PATH });
    await client.nextMsg((m) => (m as { type: string }).type === "file_history_response");
  }

  it("resend of the current head adds no version, moves no mtime, broadcasts nothing", async () => {
    const srv = await startTestServer();
    const client1 = connectClient(srv.port);
    await waitForOpen(client1);
    await client1.auth("device-a");

    client1.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 1000), content: V1.b64 });
    await settle(client1);
    assert.equal(srv.ctx.db.getFile(PATH)?.mtime, 1000);

    const client2 = connectClient(srv.port);
    await waitForOpen(client2);
    await client2.auth("device-b");

    // Echo: same sha, fresh mtime (what a peer's escaped vault event produces).
    client1.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 2000), content: V1.b64, baseSha1: V1.sha1 });
    await settle(client1);

    // Head untouched: mtime NOT advanced, no duplicate version row.
    assert.equal(srv.ctx.db.getFile(PATH)?.mtime, 1000);
    client1.send({ type: "file_history", path: PATH });
    const hist = await client1.nextMsg<{ type: string; versions: unknown[] }>(
      (m) => (m as { type: string }).type === "file_history_response"
    );
    assert.equal(hist.versions.length, 1);

    // No broadcast for the echo: the FIRST push client2 sees must be the real
    // V2 change sent afterwards, not the V1 resend.
    client1.send({ type: "file_data", mode: "apply", file: entry(V2.sha1, 3000), content: V2.b64, baseSha1: V1.sha1 });
    const push = await client2.nextMsg<{ type: string; file: FileEntry }>(
      (m) => (m as { type: string }).type === "file_push" && (m as { file: FileEntry }).file.path === PATH
    );
    assert.equal(push.file.sha1, V2.sha1);

    client1.close();
    client2.close();
    await srv.stop();
  });

  it("E2EE upgrade (same plaintext sha, ciphertext body) is still stored", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth();

    client.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 1000), content: V1.b64 });
    await settle(client);

    // Same plaintext sha1, but the body now carries the E2EE magic header —
    // the plugin's plaintext→ciphertext upgrade path. Must NOT be dropped.
    const cipher = Buffer.from("IONENCv2" + "fake-iv-and-ct").toString("base64");
    client.send({ type: "file_data", mode: "apply", file: entry(V1.sha1, 2000), content: cipher, baseSha1: V1.sha1 });
    await settle(client);

    const latest = srv.ctx.storage.readLatest(PATH);
    assert.ok(latest && latest.subarray(0, 7).toString() === "IONENCv", "ciphertext should be stored");

    client.close();
    await srv.stop();
  });
});

describe("dashboard admin actions", () => {
  // Log in for real and reuse the server-issued random session cookie. The
  // token is no longer a deterministic function of the password (SECURITY.md #1).
  async function dashHeaders(port: number): Promise<Record<string, string>> {
    const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
      headers: { "x-dashboard-password": TEST_PASSWORD },
    });
    const token = /dash_token=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
    return { Cookie: `dash_token=${token}` };
  }

  it("rejects the legacy deterministic dash_token; only a real login is accepted (SECURITY.md #1/#2)", async () => {
    const srv = await startTestServer();
    // Pre-#1 cookie: sha256(password + "-dashboard"), which any password-holder
    // could compute offline. It must now be rejected.
    const legacy = createHash("sha256").update(TEST_PASSWORD + "-dashboard").digest("hex");
    const denied = await fetch(`http://127.0.0.1:${srv.port}/api/logs`, {
      headers: { Cookie: `dash_token=${legacy}` },
    });
    assert.equal(denied.status, 401, "legacy deterministic token must be rejected");
    // A completed /api/login yields a working random session cookie.
    const ok = await fetch(`http://127.0.0.1:${srv.port}/api/logs`, {
      headers: await dashHeaders(srv.port),
    });
    assert.equal(ok.status, 200, "a real login session must be accepted");
    await srv.stop();
  });

  it("returns 400 (not 500) on a path-traversal attempt (SECURITY.md correctness)", async () => {
    const srv = await startTestServer();
    const res = await fetch(
      `http://127.0.0.1:${srv.port}/api/file-content?path=${encodeURIComponent("../../etc/passwd")}`,
      { headers: await dashHeaders(srv.port) }
    );
    assert.equal(res.status, 400);
    await srv.stop();
  });

  it("trigger-sync asks the client to actually resync, instead of a bare sync_done", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth("device-a");

    const peer = [...srv.ctx.peers.values()].find((p) => p.deviceId === "device-a");
    assert.ok(peer, "peer should be registered after auth");

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/action/trigger-sync/${peer!.id}`, {
      headers: await dashHeaders(srv.port),
    });
    assert.equal(res.status, 200);

    // Previously this endpoint sent a bare `sync_done`, which the client just
    // treats as "no pending transfers" and does not reconcile from. It must
    // now send `request_sync` so the client actually runs a sync cycle.
    const msg = await client.nextMsg<{ type: string }>(
      (m) => (m as { type: string }).type === "request_sync"
    );
    assert.equal(msg.type, "request_sync");

    client.close();
    await srv.stop();
  });

  it("delete-file pushes the deletion live to other connected peers", async () => {
    const srv = await startTestServer();
    const uploader = connectClient(srv.port);
    await waitForOpen(uploader);
    await uploader.auth("device-a");

    const PATH = "notes/to-delete.md";
    const sha1 = "7bd81a159ea42d0f32dc1bcac2b3756123a985c7"; // sha1("v one")
    const content = Buffer.from("v one").toString("base64");
    uploader.send({
      type: "file_data",
      mode: "apply",
      file: { path: PATH, sha1, mtime: 1000, action: "active", fileType: "file" },
      content,
    });
    uploader.send({ type: "file_history", path: PATH });
    await uploader.nextMsg((m) => (m as { type: string }).type === "file_history_response");
    assert.equal(srv.ctx.db.getFile(PATH)?.action, "active");

    // A second peer connects AFTER the upload, so it only ever learns about
    // the delete via the live broadcast this test is checking for.
    const watcher = connectClient(srv.port);
    await waitForOpen(watcher);
    await watcher.auth("device-b");

    const res = await fetch(
      `http://127.0.0.1:${srv.port}/api/delete-file/${encodeURIComponent(PATH)}`,
      { method: "DELETE", headers: await dashHeaders(srv.port) }
    );
    assert.equal(res.status, 200);

    const push = await watcher.nextMsg<{ type: string; file: FileEntry }>(
      (m) => (m as { type: string }).type === "file_push" && (m as { file: FileEntry }).file.path === PATH
    );
    assert.equal(push.file.action, "deleted");
    assert.equal(srv.ctx.db.getFile(PATH)?.action, "deleted");

    uploader.close();
    watcher.close();
    await srv.stop();
  });

  it("delete-folder marks every file under a prefix deleted and broadcasts each, leaving siblings untouched", async () => {
    const srv = await startTestServer();
    const uploader = connectClient(srv.port);
    await waitForOpen(uploader);
    await uploader.auth("device-a");

    // Two files inside "Projects", one sibling outside it.
    const files = [
      { path: "Projects/a.md", sha1: "ba2af8b699b34a4d9255297507b3786a35000229", content: "Zm9uZQ==" },
      { path: "Projects/sub/b.md", sha1: "322dd25e567dce1fe1ed7ac498d278b895b089ba", content: "ZnR3bw==" },
      { path: "Other/c.md", sha1: "45e18dad51fd9e8869897fba48fa93d118e5e404", content: "b3V0c2lkZQ==" },
    ];
    for (const f of files) {
      uploader.send({
        type: "file_data", mode: "apply",
        file: { path: f.path, sha1: f.sha1, mtime: 1000, action: "active", fileType: "file" },
        content: f.content,
      });
    }
    // Round-trip a history request so all three uploads are committed.
    uploader.send({ type: "file_history", path: "Other/c.md" });
    await uploader.nextMsg((m) => (m as { type: string }).type === "file_history_response");
    for (const f of files) assert.equal(srv.ctx.db.getFile(f.path)?.action, "active");

    const watcher = connectClient(srv.port);
    await waitForOpen(watcher);
    await watcher.auth("device-b");

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/delete-folder`, {
      method: "POST",
      headers: { ...(await dashHeaders(srv.port)), "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "Projects" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, prefix: "Projects", deleted: 2 });

    // Both in-folder files broadcast as deletions...
    const deletedPaths = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const push = await watcher.nextMsg<{ type: string; file: FileEntry }>(
        (m) => (m as { type: string }).type === "file_push" &&
               (m as { file: FileEntry }).file.action === "deleted"
      );
      deletedPaths.add(push.file.path);
    }
    assert.deepEqual([...deletedPaths].sort(), ["Projects/a.md", "Projects/sub/b.md"]);

    assert.equal(srv.ctx.db.getFile("Projects/a.md")?.action, "deleted");
    assert.equal(srv.ctx.db.getFile("Projects/sub/b.md")?.action, "deleted");
    // The sibling outside the prefix is untouched.
    assert.equal(srv.ctx.db.getFile("Other/c.md")?.action, "active");

    uploader.close();
    watcher.close();
    await srv.stop();
  });

  it("SSE /api/events streams a change frame when server state changes", async () => {
    const srv = await startTestServer();
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/events`, {
      headers: await dashHeaders(srv.port),
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    // Trigger a change: a real upload funnels through pushActivity → emitSse.
    const uploader = connectClient(srv.port);
    await waitForOpen(uploader);
    await uploader.auth("device-a");
    uploader.send({
      type: "file_data",
      mode: "apply",
      file: { path: "notes/sse.md", sha1: "7bd81a159ea42d0f32dc1bcac2b3756123a985c7", mtime: 1000, action: "active", fileType: "file" },
      content: Buffer.from("v one").toString("base64"),
    });

    // Read the stream until the coalesced `change` frame arrives (or time out).
    let buf = "";
    const deadline = Date.now() + 6000;
    while (!buf.includes("event: change") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((r) =>
          setTimeout(() => r({ value: undefined, done: false }), 1000)
        ),
      ]);
      if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
      if (chunk.done) break;
    }
    assert.match(buf, /event: change/);
    assert.match(buf, /"kinds"/);

    ac.abort();
    await reader.cancel().catch(() => {});
    uploader.close();
    await srv.stop();
  });
});

describe("empty conflicting uploads never mint a copy", () => {
  it("an E2EE-empty upload that conflicts keeps the head and creates NO conflict copy", async () => {
    const srv = await startTestServer();
    const PATH = "notes/real.md";
    // Seed a real head with content (and a version row).
    srv.ctx.db.upsertFile({ path: PATH, sha1: "headsha0000000000000000000000000000abcd", mtime: 5000, action: "active", fileType: "file" });
    srv.ctx.storage.write(PATH, 5000, Buffer.from("real content here"));

    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth("device-a");

    // Encrypted-empty blob: "IONENCv1" magic (8) + 28 bytes = 36 total = empty plaintext.
    const emptyE2ee = Buffer.concat([Buffer.from("IONENCv1"), Buffer.alloc(28)]);
    client.send({
      type: "file_data",
      mode: "apply",
      // older mtime + a baseSha1 unknown to history → decideUpload returns "conflict"
      file: { path: PATH, sha1: "uploadsha000000000000000000000000000beef", mtime: 1000, action: "active", fileType: "file" },
      content: emptyE2ee.toString("base64"),
      baseSha1: "0000000000000000000000000000000000000000",
    });

    const res = await client.nextMsg<{ type: string; result?: string }>(
      (m) => (m as { type: string }).type === "file_event_result"
    );
    assert.equal(res.result, "conflict", "empty upload from a stale base is a conflict");
    // The key assertion: NO empty "(Conflicted Copy)" stub was created.
    const copies = srv.ctx.db.getAllFiles().filter((f) => /Conflicted Copy/.test(f.path));
    assert.equal(copies.length, 0, "an empty conflicting upload must not mint a copy");
    // The real head is untouched.
    assert.equal(srv.ctx.storage.readLatest(PATH)?.toString(), "real content here");

    client.close();
    await srv.stop();
  });

  it("isEmptyUpload recognises empty plaintext and empty E2EE, not real content", async () => {
    const { isEmptyUpload } = await import("../src/ws/handlers/fileData.js");
    assert.equal(isEmptyUpload(Buffer.alloc(0)), true);                                  // 0-byte plain
    assert.equal(isEmptyUpload(Buffer.from("hello")), false);                            // plain content
    assert.equal(isEmptyUpload(Buffer.concat([Buffer.from("IONENCv1"), Buffer.alloc(28)])), true);  // 36B E2EE = empty
    assert.equal(isEmptyUpload(Buffer.concat([Buffer.from("IONENCv1"), Buffer.alloc(200)])), false); // real E2EE
  });
});


describe("hidden/config path detection (incl. 8.3 short-name twin)", () => {
  it("treats OBSIDI~1 (the .obsidian 8.3 alias) as config, so it never mints a conflict copy", async () => {
    const { isHiddenOrConfigPath, isShortNameConfigDir } = await import("../src/ws/handlers/fileData.js");

    // Real dotted config — unchanged behaviour.
    assert.equal(isHiddenOrConfigPath(".obsidian/app.json"), true);
    assert.equal(isHiddenOrConfigPath("notes/.hidden/x.md"), true);

    // The corrupted short-name twin, top-level and nested under a short-name tree.
    assert.equal(isShortNameConfigDir("OBSIDI~1/plugins/tasknotes/data.json"), true);
    assert.equal(isHiddenOrConfigPath("OBSIDI~1/plugins/tasknotes/data.json"), true);
    assert.equal(isHiddenOrConfigPath("Efforts/ACTIVE~1/x/OBSIDI~1/plugins/ink/data.json"), true);
    assert.equal(isHiddenOrConfigPath("obsidi~2/plugins/foo.json"), true); // case + index tolerant

    // Ordinary content must stay non-config (still eligible for real conflicts).
    assert.equal(isHiddenOrConfigPath("Atlas/Bible/Genesis.md"), false);
    assert.equal(isShortNameConfigDir("Atlas/Bible/Genesis.md"), false);
    // A filename that merely contains a tilde is not a config dir.
    assert.equal(isShortNameConfigDir("notes/my~1note.md"), false);
  });
});
