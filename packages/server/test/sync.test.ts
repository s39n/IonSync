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

    // The conflicted copy is pushed back to the uploader with the rejected content…
    const copyPush = await client.nextMsg<{ type: string; file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_push" &&
             (m as { file: FileEntry }).file.path.includes("(Conflicted Copy")
    );
    assert.equal(copyPush.content, V3.b64);
    assert.equal(copyPush.file.sha1, V3.sha1);

    // …and the server re-pushes its head so the uploader converges.
    const headPush = await client.nextMsg<{ type: string; file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_push" &&
             (m as { file: FileEntry }).file.path === PATH
    );
    assert.equal(headPush.content, V2.b64);

    // Server head untouched; copy registered in the DB.
    assert.equal(srv.ctx.db.getFile(PATH)?.sha1, V2.sha1);
    const copy = srv.ctx.db.getAllFiles().find((f) => f.path.includes("(Conflicted Copy"));
    assert.ok(copy);
    assert.equal(copy?.sha1, V3.sha1);
    assert.equal(copy?.action, "active");

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
  it("keeps the extension so peers route the copy through binary handling", async () => {
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

    // Stale base → conflict; copy must stay inside assets.v2/ and end in .png.
    client.send({ type: "file_data", mode: "apply", file: entry(V3.sha1, 3000), content: V3.b64, baseSha1: V1.sha1 });
    const copyPush = await client.nextMsg<{ type: string; file: FileEntry; content: string }>(
      (m) => (m as { type: string }).type === "file_push" &&
             (m as { file: FileEntry }).file.path.includes("(Conflicted Copy")
    );
    assert.match(copyPush.file.path, /^assets\.v2\/photo \(Conflicted Copy [^/]+\)\.png$/);
    assert.equal(copyPush.content, V3.b64);

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

describe("dashboard admin actions", () => {
  function dashHeaders(): Record<string, string> {
    const token = createHash("sha256").update(TEST_PASSWORD + "-dashboard").digest("hex");
    return { Cookie: `dash_token=${token}` };
  }

  it("trigger-sync asks the client to actually resync, instead of a bare sync_done", async () => {
    const srv = await startTestServer();
    const client = connectClient(srv.port);
    await waitForOpen(client);
    await client.auth("device-a");

    const peer = [...srv.ctx.peers.values()].find((p) => p.deviceId === "device-a");
    assert.ok(peer, "peer should be registered after auth");

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/action/trigger-sync/${peer!.id}`, {
      headers: dashHeaders(),
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
      { method: "DELETE", headers: dashHeaders() }
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
});
