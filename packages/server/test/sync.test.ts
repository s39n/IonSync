import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import type { FileEntry } from "@ionsync/protocol";
import { connectClient, startTestServer, waitForOpen } from "./helpers.js";

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
