/**
 * End-to-end: a real sync server (the server package's test harness), a real
 * gateway connected to it as a device, and HTTP calls against the gateway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { startTestServer, connectClient, waitForOpen, TEST_PASSWORD } from "../../server/test/helpers.js";
import type { TestClient, TestServer } from "../../server/test/helpers.js";
import { createGateway, type Gateway } from "../src/gateway.js";
import type { ApiConfig } from "../src/config.js";

const TOKEN = "w".repeat(32);
const READ_TOKEN = "r".repeat(32);

const sha1 = (s: string): string => createHash("sha1").update(Buffer.from(s)).digest("hex");

interface Api {
  gw: Gateway;
  call(method: string, path: string, body?: unknown, token?: string | null): Promise<{ status: number; body: any }>;
}

async function startApi(srv: TestServer, overrides: Partial<ApiConfig> = {}): Promise<Api> {
  const cfg: ApiConfig = {
    serverUrl: `ws://127.0.0.1:${srv.port}`,
    password: TEST_PASSWORD,
    e2eePassword: null,
    e2eeVersion: null,
    token: TOKEN,
    readToken: READ_TOKEN,
    port: 0,
    host: "127.0.0.1",
    trustProxy: false,
    deviceId: "llm-api-test",
    deviceName: "LLM API",
    maxDeletesPerHour: 60,
    maxNoteBytes: 5 * 1024 * 1024,
    log: () => undefined,
    ...overrides,
  };
  const gw = createGateway(cfg);
  const port = await gw.listen();
  await gw.vault.whenSynced(10_000);
  return {
    gw,
    async call(method, path, body, token = TOKEN) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

async function device(srv: TestServer, id: string): Promise<TestClient> {
  const c = connectClient(srv.port);
  await waitForOpen(c);
  await c.auth(id);
  return c;
}

/** Upload from a plugin-like device and wait until the server has processed it. */
async function deviceWrite(c: TestClient, path: string, text: string, baseSha1?: string): Promise<void> {
  c.send({
    type: "file_data",
    mode: "apply",
    file: { path, sha1: sha1(text), mtime: Date.now(), action: "active", fileType: "file" },
    content: Buffer.from(text).toString("base64"),
    ...(baseSha1 ? { baseSha1 } : {}),
  });
  c.send({ type: "file_history", path });
  await c.nextMsg((m) => (m as { type: string; path?: string }).type === "file_history_response" && (m as { path: string }).path === path);
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const enc = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

test("bootstrap: notes already on the server are readable, listed and searchable", async () => {
  const srv = await startTestServer();
  const dev = await device(srv, "device-a");
  let api: Api | undefined;
  try {
    await deviceWrite(dev, "Projects/Plan.md", "# Plan\nShip the LLM API.\n");
    await deviceWrite(dev, "Daily/Monday log.md", "Churned vanilla.\n");
    await deviceWrite(dev, ".obsidian/app.json", "{}");
    api = await startApi(srv);

    const read = await api.call("GET", `/v1/notes/${enc("Projects/Plan.md")}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.content, "# Plan\nShip the LLM API.\n");
    assert.equal(read.body.sha1, sha1("# Plan\nShip the LLM API.\n"));

    const list = await api.call("GET", "/v1/notes");
    assert.deepEqual(list.body.notes.map((n: { path: string }) => n.path), ["Daily/Monday log.md", "Projects/Plan.md"]);
    assert.equal((await api.call("GET", "/v1/notes?prefix=Daily/")).body.total, 1);

    const found = await api.call("GET", "/v1/search?q=vanilla");
    assert.equal(found.body.results[0].path, "Daily/Monday log.md");
    assert.equal(found.body.results[0].snippets[0].text, "Churned vanilla.");

    assert.equal((await api.call("GET", `/v1/notes/${enc("Nope.md")}`)).status, 404);
  } finally {
    await api?.gw.close();
    dev.close();
    await srv.stop();
  }
});

test("auth: token required; read-only token cannot write; paths are fenced", async () => {
  const srv = await startTestServer();
  const api = await startApi(srv);
  try {
    assert.equal((await api.call("GET", "/v1/notes", undefined, null)).status, 401);
    assert.equal((await api.call("GET", "/v1/notes", undefined, "x".repeat(32))).status, 401);
    assert.equal((await api.call("GET", "/v1/health", undefined, null)).status, 200);
    assert.equal((await api.call("GET", "/v1/openapi.json", undefined, null)).body.openapi, "3.1.0");

    assert.equal((await api.call("GET", "/v1/notes", undefined, READ_TOKEN)).status, 200);
    const denied = await api.call("PUT", "/v1/notes/A.md", { content: "x" }, READ_TOKEN);
    assert.equal(denied.status, 403);

    assert.equal((await api.call("PUT", `/v1/notes/${enc(".obsidian/app.json")}`, { content: "{}" })).status, 403);
    assert.equal((await api.call("PUT", "/v1/notes/a/..%2F..%2Fescape.md", { content: "x" })).status, 400);
    assert.equal((await api.call("PUT", "/v1/notes/image.png", { content: "x" })).status, 400);
    assert.equal((await api.call("PUT", "/v1/notes/A.md", { nope: 1 })).status, 400);
    assert.equal(srv.ctx.db.getAllFiles().length, 0);
  } finally {
    await api.gw.close();
    await srv.stop();
  }
});

test("auth: repeated bad tokens are rate limited", async () => {
  const srv = await startTestServer();
  const api = await startApi(srv);
  try {
    for (let i = 0; i < 10; i++) {
      assert.equal((await api.call("GET", "/v1/notes", undefined, "bad-token-" + i)).status, 401);
    }
    assert.equal((await api.call("GET", "/v1/notes", undefined, "bad-token-x")).status, 429);
    // Blocked by address: even the right token waits out the window.
    assert.equal((await api.call("GET", "/v1/notes")).status, 429);
  } finally {
    await api.gw.close();
    await srv.stop();
  }
});

test("write: creates a note, lands on the server, and is pushed to other devices", async () => {
  const srv = await startTestServer();
  const dev = await device(srv, "device-a");
  const api = await startApi(srv);
  try {
    const res = await api.call("PUT", `/v1/notes/${enc("Inbox/From Claude.md")}`, { content: "Hello from an LLM.\n" });
    assert.equal(res.status, 201);
    assert.equal(res.body.created, true);

    const head = srv.ctx.db.getFile("Inbox/From Claude.md");
    assert.equal(head?.sha1, sha1("Hello from an LLM.\n"));
    assert.equal(srv.ctx.storage.readLatest("Inbox/From Claude.md")?.toString(), "Hello from an LLM.\n");

    const push = await dev.nextMsg<{ file: { path: string }; content: string }>(
      (m) => (m as { type: string }).type === "file_push" && (m as { file: { path: string } }).file.path === "Inbox/From Claude.md"
    );
    assert.equal(Buffer.from(push.content, "base64").toString(), "Hello from an LLM.\n");

    // Replace, with and without the optimistic-concurrency guard.
    const again = await api.call("PUT", `/v1/notes/${enc("Inbox/From Claude.md")}`, { content: "v2\n", expectedSha1: res.body.sha1 });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    const stale = await api.call("PUT", `/v1/notes/${enc("Inbox/From Claude.md")}`, { content: "v3\n", expectedSha1: res.body.sha1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "stale");
    const dup = await api.call("PUT", `/v1/notes/${enc("Inbox/From Claude.md")}`, { content: "x", createOnly: true });
    assert.equal(dup.body.error.code, "already_exists");
    // Same content again: no new version.
    const noop = await api.call("PUT", `/v1/notes/${enc("Inbox/From Claude.md")}`, { content: "v2\n" });
    assert.equal(noop.body.changed, false);
    assert.equal(srv.ctx.storage.readLatest("Inbox/From Claude.md")?.toString(), "v2\n");
  } finally {
    await api.gw.close();
    dev.close();
    await srv.stop();
  }
});

test("live: an edit from a device shows up through the API", async () => {
  const srv = await startTestServer();
  const dev = await device(srv, "device-a");
  const api = await startApi(srv);
  try {
    await deviceWrite(dev, "Live.md", "one");
    await until(() => api.gw.vault.get("Live.md")?.text === "one");
    await deviceWrite(dev, "Live.md", "two", sha1("one"));
    await until(() => api.gw.vault.get("Live.md")?.text === "two");
    assert.equal((await api.call("GET", "/v1/notes/Live.md")).body.content, "two");

    // Device deletes it.
    dev.send({ type: "file_data", mode: "apply", file: { path: "Live.md", sha1: sha1("two"), mtime: Date.now(), action: "deleted", fileType: "file" }, content: "" });
    await until(() => api.gw.vault.get("Live.md") === undefined);
    assert.equal((await api.call("GET", "/v1/notes/Live.md")).status, 404);
  } finally {
    await api.gw.close();
    dev.close();
    await srv.stop();
  }
});

test("edit: targeted operations go through as one new version", async () => {
  const srv = await startTestServer();
  const api = await startApi(srv);
  try {
    await api.call("PUT", "/v1/notes/Todo.md", { content: "# Todo\n\n## Today\n- milk\n\n## Later\n- taxes\n" });
    const res = await api.call("PATCH", "/v1/notes/Todo.md", {
      operations: [
        { op: "insert_under_heading", heading: "Today", text: "- eggs" },
        { op: "replace", find: "- taxes", replace: "- taxes (April)" },
        { op: "append", text: "Updated by the API." },
      ],
    });
    assert.equal(res.status, 200);
    const want = "# Todo\n\n## Today\n- milk\n- eggs\n\n## Later\n- taxes (April)\nUpdated by the API.";
    assert.equal(srv.ctx.storage.readLatest("Todo.md")?.toString(), want);
    assert.equal(res.body.sha1, sha1(want));

    // A failing operation changes nothing.
    const bad = await api.call("PATCH", "/v1/notes/Todo.md", {
      operations: [{ op: "append", text: "x" }, { op: "replace", find: "not there", replace: "y" }],
    });
    assert.equal(bad.status, 422);
    assert.equal(srv.ctx.storage.readLatest("Todo.md")?.toString(), want);
    assert.equal((await api.call("PATCH", "/v1/notes/Missing.md", { operations: [{ op: "append", text: "x" }] })).status, 404);
  } finally {
    await api.gw.close();
    await srv.stop();
  }
});

test("conflict: a write based on a stale version never overwrites the newer one", async () => {
  const srv = await startTestServer();
  const dev = await device(srv, "device-a");
  const api = await startApi(srv);
  try {
    await deviceWrite(dev, "Race.md", "base");
    await deviceWrite(dev, "Race.md", "device edit", sha1("base"));
    await until(() => api.gw.vault.get("Race.md")?.text === "device edit");

    // Simulate the race: the API's view is one version behind the server.
    const stale = api.gw.vault.get("Race.md")!;
    api.gw.vault.notes.set("Race.md", { ...stale, sha1: sha1("base"), text: "base" });

    const res = await api.call("PUT", "/v1/notes/Race.md", { content: "llm edit" });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "conflict");
    assert.equal(srv.ctx.storage.readLatest("Race.md")?.toString(), "device edit");
    assert.equal(srv.ctx.db.hasOpenConflict("Race.md", sha1("llm edit")), true); // losing side preserved

    // The server re-pushed its head, so the API has converged.
    await until(() => api.gw.vault.get("Race.md")?.text === "device edit");
  } finally {
    await api.gw.close();
    dev.close();
    await srv.stop();
  }
});

test("move and delete: propagate to the server and to devices", async () => {
  const srv = await startTestServer();
  const dev = await device(srv, "device-a");
  const api = await startApi(srv, { maxDeletesPerHour: 1 });
  try {
    await api.call("PUT", "/v1/notes/Draft.md", { content: "draft" });
    await api.call("PUT", "/v1/notes/Other.md", { content: "other" });

    assert.equal((await api.call("POST", "/v1/move", { from: "Draft.md", to: "Other.md" })).status, 409);
    const moved = await api.call("POST", "/v1/move", { from: "Draft.md", to: "Archive/Final.md" });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.path, "Archive/Final.md");
    assert.equal(srv.ctx.db.getFile("Draft.md")?.action, "deleted");
    assert.equal(srv.ctx.db.getFile("Archive/Final.md")?.action, "active");
    assert.equal((await api.call("GET", `/v1/notes/${enc("Archive/Final.md")}`)).body.content, "draft");
    assert.equal((await api.call("GET", "/v1/notes/Draft.md")).status, 404);
    // History followed the move.
    assert.ok(srv.ctx.db.hasVersionSha("Archive/Final.md", sha1("draft")));

    const del = await api.call("DELETE", `/v1/notes/${enc("Archive/Final.md")}`);
    assert.equal(del.status, 200);
    assert.equal(srv.ctx.db.getFile("Archive/Final.md")?.action, "deleted");
    await dev.nextMsg(
      (m) => (m as { type: string }).type === "file_push" &&
        (m as { file: { path: string; action: string } }).file.path === "Archive/Final.md" &&
        (m as { file: { action: string } }).file.action === "deleted"
    );

    // The hourly delete cap stops a runaway caller.
    const capped = await api.call("DELETE", "/v1/notes/Other.md");
    assert.equal(capped.status, 429);
    assert.equal(srv.ctx.db.getFile("Other.md")?.action, "active");
  } finally {
    await api.gw.close();
    dev.close();
    await srv.stop();
  }
});

test("e2ee: the server only ever holds ciphertext; a second gateway reads it back", async () => {
  const srv = await startTestServer();
  const a = await startApi(srv, { e2eePassword: "vault-secret", deviceId: "llm-api-a" });
  let b: Api | undefined;
  let c: Api | undefined;
  try {
    const res = await a.call("PUT", "/v1/notes/Secret.md", { content: "for my eyes only" });
    assert.equal(res.status, 201);
    const stored = srv.ctx.storage.readLatest("Secret.md")!;
    assert.equal(stored.subarray(0, 8).toString("ascii"), "IONENCv2");
    assert.equal(stored.includes(Buffer.from("for my eyes only")), false);
    assert.equal(srv.ctx.db.getFile("Secret.md")?.sha1, sha1("for my eyes only")); // sha is of the plaintext

    // Opting into the per-install-salt format.
    const v3 = await startApi(srv, { e2eePassword: "vault-secret", e2eeVersion: 3, deviceId: "llm-api-v3" });
    await v3.call("PATCH", "/v1/notes/Secret.md", { operations: [{ op: "append", text: "v3 line" }] });
    assert.equal(srv.ctx.storage.readLatest("Secret.md")!.subarray(0, 8).toString("ascii"), "IONENCv3");
    await v3.gw.close();

    b = await startApi(srv, { e2eePassword: "vault-secret", deviceId: "llm-api-b" });
    assert.equal((await b.call("GET", "/v1/notes/Secret.md")).body.content, "for my eyes only\nv3 line");
    // Having seen v3 in the vault, it keeps writing v3.
    await b.call("PUT", "/v1/notes/Secret.md", { content: "rewritten" });
    assert.equal(srv.ctx.storage.readLatest("Secret.md")!.subarray(0, 8).toString("ascii"), "IONENCv3");

    // No password (or the wrong one): refuses rather than serving or clobbering ciphertext.
    c = await startApi(srv, { e2eePassword: "wrong", deviceId: "llm-api-c" });
    const locked = await c.call("GET", "/v1/notes/Secret.md");
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, "unreadable");
    assert.equal((await c.call("PUT", "/v1/notes/Secret.md", { content: "clobber" })).status, 409);
    assert.equal((await c.call("GET", "/v1/search?q=rewritten")).body.results.length, 0);
  } finally {
    await a.gw.close();
    await b?.gw.close();
    await c?.gw.close();
    await srv.stop();
  }
});

test("reconnect: the mirror catches up on what it missed", async () => {
  const srv = await startTestServer();
  const dev = await device(srv, "device-a");
  const api = await startApi(srv);
  try {
    await deviceWrite(dev, "Keep.md", "keep");
    await deviceWrite(dev, "Gone.md", "gone");
    await until(() => api.gw.vault.notes.size === 2);

    // Drop the gateway's socket; change things while it is away.
    for (const peer of srv.ctx.peers.values()) if (peer.deviceId === "llm-api-test") peer.ws.terminate();
    await until(() => !api.gw.vault.connected);
    await deviceWrite(dev, "New.md", "new");
    dev.send({ type: "file_data", mode: "apply", file: { path: "Gone.md", sha1: sha1("gone"), mtime: Date.now(), action: "deleted", fileType: "file" }, content: "" });

    await until(() => api.gw.vault.connected && api.gw.vault.get("New.md")?.text === "new" && !api.gw.vault.get("Gone.md"), 8000);
    assert.equal(api.gw.vault.get("Keep.md")?.text, "keep");
  } finally {
    await api.gw.close();
    dev.close();
    await srv.stop();
  }
});
