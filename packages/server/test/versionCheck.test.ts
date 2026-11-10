/**
 * Plugin auto-update offer (version_check).
 *
 * A server only offers its bundled plugin build when that build is SIGNED.
 * Clients pin the update key and refuse anything unsigned, so offering an
 * unsigned bundle (a self-built or public image) could never update a device —
 * it only produced a "Blocked an unsigned plugin update" warning on every
 * connect. A signed build must still be offered exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { connectClient, startTestServer, waitForOpen, TEST_PASSWORD, type TestClient, type TestServer } from "./helpers.js";

type Msg = { type: string; [k: string]: unknown };
const ofType = (t: string) => (m: unknown) => (m as Msg).type === t;

async function connect(port: number, deviceId: string): Promise<TestClient> {
  const c = connectClient(port);
  await waitForOpen(c);
  const { nonce } = await c.nextMsg<{ nonce: string }>(ofType("challenge"));
  const token = createHash("sha256").update(nonce.slice(0, 16) + TEST_PASSWORD + nonce.slice(16)).digest("hex");
  c.send({ type: "auth", deviceId, token });
  await c.nextMsg(ofType("auth_ok"));
  return c;
}

/** Put a plugin build into the server's client dir, as the image build does. */
function installBuild(srv: TestServer, info: Record<string, unknown>): void {
  const dir = srv.ctx.clientDir;
  fs.writeFileSync(path.join(dir, "main.js"), "console.log('plugin');");
  fs.writeFileSync(path.join(dir, "manifest.json"), '{"id":"ion-sync"}');
  fs.writeFileSync(path.join(dir, "styles.css"), "/* css */");
  fs.writeFileSync(path.join(dir, "build_info.json"), JSON.stringify(info));
}

async function versionCheck(srv: TestServer, version: string, build: string): Promise<Msg> {
  const c = await connect(srv.port, "devA");
  try {
    c.send({ type: "version_check", version, build });
    return await c.nextMsg<Msg>(ofType("version_check_response"));
  } finally {
    c.close();
  }
}

test("an unsigned build is never offered, even to an out-of-date client", async () => {
  const srv = await startTestServer();
  try {
    installBuild(srv, { version: "9.9.9", build: "newer-build" });
    const res = await versionCheck(srv, "2.0.0", "old-build");
    assert.equal(res.needsUpdate, false);
    assert.equal(res.files, undefined, "no plugin files may be sent for an unsigned build");
    assert.ok(Array.isArray(res.caps) && (res.caps as string[]).length > 0, "capabilities are still advertised");
  } finally {
    await srv.stop();
  }
});

test("a signed build is offered to an out-of-date client, with its signatures", async () => {
  const srv = await startTestServer();
  try {
    installBuild(srv, { version: "9.9.9", build: "newer-build", sig: "c2lnbmF0dXJl", filesSig: "ZmlsZXNTaWc=" });
    const res = await versionCheck(srv, "2.0.0", "old-build");
    assert.equal(res.needsUpdate, true);
    assert.equal(res.signature, "c2lnbmF0dXJl");
    assert.equal(res.filesSignature, "ZmlsZXNTaWc=");
    const files = res.files as Record<string, string>;
    assert.equal(Buffer.from(files["main.js"] ?? "", "base64").toString(), "console.log('plugin');");
  } finally {
    await srv.stop();
  }
});

test("a signed build is not offered to a client already on that build", async () => {
  const srv = await startTestServer();
  try {
    installBuild(srv, { version: "9.9.9", build: "same-build", sig: "c2lnbmF0dXJl" });
    const res = await versionCheck(srv, "9.9.9", "same-build");
    assert.equal(res.needsUpdate, false);
  } finally {
    await srv.stop();
  }
});
