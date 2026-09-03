/**
 * E2EE re-key migration through the upload handler (SECURITY.md #7).
 *
 * "Re-encrypt all files" re-uploads every note re-wrapped in the new format
 * (v2 global salt → v3 per-install salt). The plaintext is unchanged, so the
 * SHA-1 (which is of the plaintext) is identical. The echo-storm guard
 * `isNoopResend` drops same-SHA resends — but it must make an exception when the
 * stored ciphertext is a DIFFERENT format version, or the migration silently
 * does nothing. This test pins that: a v2→v3 re-upload is stored, while a
 * same-version resend is still dropped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, connectClient, waitForOpen, type TestClient, type TestServer } from "./helpers.js";

const PATH = "note.md";
const SHA = "1111111111111111111111111111111111111111"; // plaintext SHA-1 (unchanged across re-keys)

/** A minimal well-formed E2EE blob for the given version: MAGIC[8]+IV[12]+ct+tag[16]. */
function blob(version: number): Buffer {
  const magic = Buffer.from(`IONENCv${version}`, "utf8"); // 8 bytes
  const body = Buffer.alloc(12 + 20 + 16); // iv + ciphertext + tag, keeps it > 36 bytes (not "empty")
  return Buffer.concat([magic, body]);
}

function upload(client: TestClient, version: number, mtime: number): void {
  client.send({
    type: "file_data",
    mode: "apply",
    file: { path: PATH, sha1: SHA, mtime, action: "active", fileType: "file" },
    content: blob(version).toString("base64"),
  });
}

async function commit(client: TestClient): Promise<void> {
  client.send({ type: "file_history", path: PATH });
  await client.nextMsg((m) => (m as { type: string }).type === "file_history_response");
}

function headVersion(ts: TestServer): number | null {
  const buf = ts.ctx.storage.readLatest(PATH);
  if (!buf) return null;
  return buf.subarray(0, 8).toString("utf8") === "IONENCv2" ? 2
    : buf.subarray(0, 8).toString("utf8") === "IONENCv3" ? 3
    : null;
}

test("a v2→v3 re-key is stored (not dropped as a no-op resend)", async () => {
  const ts = await startTestServer();
  const a = connectClient(ts.port);
  try {
    await waitForOpen(a);
    await a.auth("device-a");

    // Seed a v2-encrypted head.
    upload(a, 2, 1000);
    await commit(a);
    assert.equal(headVersion(ts), 2, "head starts at v2");
    assert.equal(ts.ctx.db.getFile(PATH)?.mtime, 1000);

    // Re-encrypt: same plaintext SHA, new v3 ciphertext. Must be stored.
    upload(a, 3, 2000);
    await commit(a);
    assert.equal(headVersion(ts), 3, "v2→v3 re-key must replace the stored blob");
    assert.equal(ts.ctx.db.getFile(PATH)?.mtime, 2000, "head advanced to the re-keyed upload");

    // A second v3 upload with the same SHA and version is a true no-op → dropped.
    upload(a, 3, 3000);
    await commit(a);
    assert.equal(headVersion(ts), 3);
    assert.equal(ts.ctx.db.getFile(PATH)?.mtime, 2000,
      "same-version same-SHA resend is still dropped (echo-storm guard intact)");
  } finally {
    a.close();
    await ts.stop();
  }
});

test("a re-key broadcasts to other connected peers", async () => {
  const ts = await startTestServer();
  const a = connectClient(ts.port);
  const b = connectClient(ts.port);
  try {
    await waitForOpen(a);
    await a.auth("device-a");
    upload(a, 2, 1000);
    await commit(a);

    await waitForOpen(b);
    await b.auth("device-b"); // b syncs the v2 head on connect

    // a re-keys to v3 → server must push the new blob to b.
    upload(a, 3, 2000);
    const push = await b.nextMsg<{ type: string; file: { path: string } }>(
      (m) => (m as { type: string }).type === "file_push"
        && (m as { file?: { path?: string } }).file?.path === PATH,
      8000,
    );
    assert.equal(push.file.path, PATH, "the re-keyed blob is broadcast to peers");
  } finally {
    a.close();
    b.close();
    await ts.stop();
  }
});
