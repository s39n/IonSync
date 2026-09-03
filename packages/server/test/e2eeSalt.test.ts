/**
 * Per-install E2EE salt distribution (SECURITY.md #7).
 *
 * The server generates a random salt once, keeps it stable for the vault's
 * life, and hands it to every device in auth_ok. Format v3 E2EE derives the
 * key with this salt instead of the old fixed global salt, defeating
 * precomputation and cross-install key reuse. This test asserts the salt is
 * well-formed, delivered on auth, and identical across reconnects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startTestServer, connectClient, waitForOpen, TEST_PASSWORD } from "./helpers.js";

/** Do the challenge/auth handshake by hand so we can capture the auth_ok msg. */
async function authCaptureOk(port: number, deviceId: string) {
  const client = connectClient(port);
  await waitForOpen(client);
  const challenge = await client.nextMsg<{ type: string; nonce: string }>(
    (m) => (m as { type: string }).type === "challenge"
  );
  const nonce = challenge.nonce;
  const token = createHash("sha256")
    .update(nonce.slice(0, 16) + TEST_PASSWORD + nonce.slice(16))
    .digest("hex");
  client.send({ type: "auth", deviceId, token });
  const ok = await client.nextMsg<{ type: string; e2eeSalt?: string }>(
    (m) => (m as { type: string }).type === "auth_ok"
  );
  return { client, ok };
}

test("auth_ok carries a well-formed per-install salt, stable across reconnects", async () => {
  const ts = await startTestServer();
  try {
    const first = await authCaptureOk(ts.port, "device-a");
    const salt = first.ok.e2eeSalt;
    assert.ok(salt, "auth_ok must include e2eeSalt");
    assert.match(salt!, /^[0-9a-f]{32}$/, "salt is 16 random bytes as hex");
    first.client.close();

    // A second device authenticating must receive the identical salt — all
    // devices have to derive the same key.
    const second = await authCaptureOk(ts.port, "device-b");
    assert.equal(second.ok.e2eeSalt, salt, "every device gets the same salt");
    second.client.close();

    // And it matches what the DB persisted (stable, not regenerated per call).
    assert.equal(ts.ctx.db.getOrCreateE2eeSalt(), salt);
    assert.equal(ts.ctx.db.getOrCreateE2eeSalt(), salt, "repeated reads are stable");
  } finally {
    await ts.stop();
  }
});
