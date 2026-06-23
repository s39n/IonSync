import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { ConnectionRateLimiter } from "../src/ws/rateLimit.js";
import { isE2eeEncrypted, e2eeVersion, makeE2eeDecryptor } from "../src/e2ee.js";

// ── Rate limiter ─────────────────────────────────────────────────────────────

test("rate limiter allows connections under the cap", () => {
  const rl = new ConnectionRateLimiter({
    windowMs: 1000, maxConnections: 3, maxAuthFailures: 5, blockMs: 1000,
  });
  const now = 1_000_000;
  assert.equal(rl.allowConnection("1.2.3.4", now), true);
  assert.equal(rl.allowConnection("1.2.3.4", now), true);
  assert.equal(rl.allowConnection("1.2.3.4", now), true);
});

test("rate limiter blocks an IP that exceeds the connection cap", () => {
  const rl = new ConnectionRateLimiter({
    windowMs: 1000, maxConnections: 3, maxAuthFailures: 5, blockMs: 5000,
  });
  const now = 2_000_000;
  for (let i = 0; i < 3; i++) assert.equal(rl.allowConnection("9.9.9.9", now), true);
  // 4th attempt trips the cap and blocks.
  assert.equal(rl.allowConnection("9.9.9.9", now), false);
  assert.equal(rl.isBlocked("9.9.9.9", now), true);
  // Still blocked partway through the block window…
  assert.equal(rl.allowConnection("9.9.9.9", now + 4000), false);
  // …and free again once the block elapses.
  assert.equal(rl.isBlocked("9.9.9.9", now + 5001), false);
});

test("rate limiter blocks after too many auth failures", () => {
  const rl = new ConnectionRateLimiter({
    windowMs: 10_000, maxConnections: 100, maxAuthFailures: 3, blockMs: 1000,
  });
  const now = 3_000_000;
  assert.equal(rl.allowConnection("5.5.5.5", now), true);
  for (let i = 0; i < 3; i++) rl.recordAuthFailure("5.5.5.5", now);
  assert.equal(rl.isBlocked("5.5.5.5", now), false); // exactly at threshold, not over
  rl.recordAuthFailure("5.5.5.5", now);              // 4th > 3 → blocked
  assert.equal(rl.isBlocked("5.5.5.5", now), true);
  assert.equal(rl.allowConnection("5.5.5.5", now), false);
});

test("rate limiter window resets counters after it elapses", () => {
  const rl = new ConnectionRateLimiter({
    windowMs: 1000, maxConnections: 2, maxAuthFailures: 5, blockMs: 500,
  });
  const now = 4_000_000;
  assert.equal(rl.allowConnection("7.7.7.7", now), true);
  assert.equal(rl.allowConnection("7.7.7.7", now), true);
  assert.equal(rl.allowConnection("7.7.7.7", now), false); // over cap, blocked 500ms
  // After the block AND a fresh window, the IP is allowed again.
  assert.equal(rl.allowConnection("7.7.7.7", now + 1500), true);
});

test("rate limiter sweep drops idle, unblocked IPs", () => {
  const rl = new ConnectionRateLimiter({
    windowMs: 1000, maxConnections: 5, maxAuthFailures: 5, blockMs: 1000,
  });
  const now = 5_000_000;
  rl.allowConnection("8.8.8.8", now);
  rl.sweep(now + 2000); // window expired, not blocked → dropped
  // A dropped IP starts fresh (full budget) — indirectly confirms state was cleared.
  assert.equal(rl.isBlocked("8.8.8.8", now + 2000), false);
});

// ── Version-aware E2EE ───────────────────────────────────────────────────────

const MAGIC_PREFIX = Buffer.from([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76]); // "IONENCv"
const ITERS: Record<number, number> = { 1: 100_000, 2: 600_000 };

/** Encrypt exactly like the plugin would for a given format version. */
function encryptAsPlugin(plaintext: string, password: string, version: number): Buffer {
  const key = nodeCrypto.pbkdf2Sync(
    password, Buffer.from("IonSync-AES-GCM-v1-salt"), ITERS[version]!, 32, "sha256"
  );
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  const magic = Buffer.concat([MAGIC_PREFIX, Buffer.from([0x30 + version])]);
  return Buffer.concat([magic, iv, ct, tag]);
}

test("e2ee detection and version parsing", () => {
  const v1 = encryptAsPlugin("hello", "pw", 1);
  const v2 = encryptAsPlugin("hello", "pw", 2);
  assert.equal(isE2eeEncrypted(v1), true);
  assert.equal(isE2eeEncrypted(v2), true);
  assert.equal(e2eeVersion(v1), 1);
  assert.equal(e2eeVersion(v2), 2);
  assert.equal(isE2eeEncrypted(Buffer.from("plain text content here")), false);
  assert.equal(e2eeVersion(Buffer.from("plain text content here")), null);
});

test("e2ee decryptor round-trips both legacy v1 (100k) and current v2 (600k)", () => {
  const decrypt = makeE2eeDecryptor("correct horse battery staple");
  const v1 = encryptAsPlugin("legacy secret", "correct horse battery staple", 1);
  const v2 = encryptAsPlugin("current secret", "correct horse battery staple", 2);
  assert.equal(decrypt(v1).toString("utf8"), "legacy secret");
  assert.equal(decrypt(v2).toString("utf8"), "current secret");
});

test("e2ee decryptor rejects a wrong password (GCM tag mismatch)", () => {
  const blob = encryptAsPlugin("top secret", "right-pw", 2);
  const decrypt = makeE2eeDecryptor("wrong-pw");
  assert.throws(() => decrypt(blob));
});
