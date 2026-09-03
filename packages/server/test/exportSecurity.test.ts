/**
 * Export routes must never decrypt E2EE content server-side (SECURITY.md #5).
 *
 * The dashboard export endpoints used to accept an X-E2EE-Password header and
 * decrypt files on the server before zipping them — meaning the passphrase and
 * plaintext both passed through (and were logged by) the server, defeating
 * end-to-end encryption. They now return the stored bytes verbatim as a JSON
 * manifest; the browser holds the vault key and decrypts + zips client-side.
 *
 * These tests assert the server hands back ciphertext even when explicitly
 * given the passphrase, and that the response is a JSON manifest (not a ZIP).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { startTestServer, TEST_PASSWORD } from "./helpers.js";

const MAGIC_PREFIX = Buffer.from([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76]); // "IONENCv"

/** Encrypt exactly like the plugin would for the current (v2) format. */
function encryptAsPlugin(plaintext: string, password: string, version = 2): Buffer {
  const iters = version === 1 ? 100_000 : 600_000;
  const key = nodeCrypto.pbkdf2Sync(
    password, Buffer.from("IonSync-AES-GCM-v1-salt"), iters, 32, "sha256"
  );
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  const magic = Buffer.concat([MAGIC_PREFIX, Buffer.from([0x30 + version])]);
  return Buffer.concat([magic, iv, ct, tag]);
}

/** Log in (no TOTP configured in tests) → the "dash_token=…" cookie + CSRF token. */
async function login(port: number): Promise<{ cookie: string; csrf: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
    headers: { "x-dashboard-password": TEST_PASSWORD },
  });
  assert.equal(r.status, 200, "login should succeed");
  const setCookie = r.headers.get("set-cookie");
  assert.ok(setCookie, "login should set a session cookie");
  const body = (await r.json()) as { csrf?: string };
  assert.ok(body.csrf, "login should return a CSRF token");
  return { cookie: setCookie.split(";")[0]!, csrf: body.csrf }; // "dash_token=<token>"
}

test("export-selected returns ciphertext and never decrypts server-side", async () => {
  const ts = await startTestServer();
  try {
    const pw = "vault-key-xyz";
    const plaintext = "SUPER SECRET NOTE — must never leave the client in cleartext";
    const enc = encryptAsPlugin(plaintext, pw, 2);
    const mtime = Date.now();
    ts.ctx.storage.write("Secret.md", mtime, enc);

    const { cookie, csrf } = await login(ts.port);

    // Deliberately send the old, now-ignored X-E2EE-Password header: even when
    // handed the passphrase, the server must NOT decrypt.
    const r = await fetch(`http://127.0.0.1:${ts.port}/api/export-selected`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cookie": cookie,
        "X-CSRF-Token": csrf,
        "X-E2EE-Password": pw,
      },
      body: JSON.stringify({ paths: ["Secret.md"] }),
    });

    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/,
      "response must be a JSON manifest, not a server-built ZIP");

    const body = (await r.json()) as {
      files: Array<{ path: string; mtime: number; encrypted: boolean; content: string }>;
    };
    assert.equal(body.files.length, 1);
    const f = body.files[0]!;
    assert.equal(f.path, "Secret.md");
    assert.equal(f.encrypted, true, "file is flagged encrypted");
    // The content is the stored ciphertext byte-for-byte — NOT the plaintext.
    assert.equal(f.content, enc.toString("base64"), "returned bytes equal the stored ciphertext");

    const returned = Buffer.from(f.content, "base64");
    assert.ok(returned.subarray(0, 7).equals(MAGIC_PREFIX), "still an IONENC blob");
    assert.ok(!returned.toString("latin1").includes("SUPER SECRET NOTE"),
      "plaintext must not appear anywhere in the response");
  } finally {
    await ts.stop();
  }
});

test("export-selected rejects an unauthenticated request", async () => {
  const ts = await startTestServer();
  try {
    ts.ctx.storage.write("x.md", Date.now(), Buffer.from("hi", "utf8"));
    const r = await fetch(`http://127.0.0.1:${ts.port}/api/export-selected`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["x.md"] }),
    });
    assert.equal(r.status, 401, "no cookie → unauthorized");
  } finally {
    await ts.stop();
  }
});

test("export-snapshot returns a JSON manifest, not a ZIP", async () => {
  const ts = await startTestServer();
  try {
    const { cookie } = await login(ts.port);
    const asOf = new Date(Date.now() + 60_000).toISOString();
    const r = await fetch(
      `http://127.0.0.1:${ts.port}/api/export-snapshot?date=${encodeURIComponent(asOf)}`,
      { headers: { "Cookie": cookie } }
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/,
      "snapshot export must be a JSON manifest");
    const body = (await r.json()) as { files: unknown[] };
    assert.ok(Array.isArray(body.files), "manifest carries a files array");
  } finally {
    await ts.stop();
  }
});
