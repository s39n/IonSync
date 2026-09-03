/**
 * TOTP secret at-rest encryption (SECURITY.md #10).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sealTotpSecret, openTotpSecret, isSealed } from "../src/totpSecret.js";

const PW = "admin-password-xyz";
const SALT = "00112233445566778899aabbccddeeff"; // 16 bytes hex
const SECRET = "JBSWY3DPEHPK3PXP"; // a base32 TOTP seed

test("seal → open round-trips the secret", () => {
  const sealed = sealTotpSecret(SECRET, PW, SALT);
  assert.ok(isSealed(sealed), "sealed value is recognised as sealed");
  assert.notEqual(sealed, SECRET, "the stored form is not the plaintext");
  assert.ok(!sealed.includes(SECRET), "plaintext seed does not appear in the blob");
  assert.equal(openTotpSecret(sealed, PW, SALT), SECRET);
});

test("a fresh seal uses a new IV each time (no deterministic ciphertext)", () => {
  const a = sealTotpSecret(SECRET, PW, SALT);
  const b = sealTotpSecret(SECRET, PW, SALT);
  assert.notEqual(a, b, "random IV → different ciphertext for the same input");
  assert.equal(openTotpSecret(a, PW, SALT), SECRET);
  assert.equal(openTotpSecret(b, PW, SALT), SECRET);
});

test("legacy plaintext secret is returned unchanged (forward-compatible read)", () => {
  assert.equal(isSealed(SECRET), false, "a bare base32 seed is not seen as sealed");
  assert.equal(openTotpSecret(SECRET, PW, SALT), SECRET);
});

test("wrong password fails authentication (does not return garbage)", () => {
  const sealed = sealTotpSecret(SECRET, PW, SALT);
  assert.throws(() => openTotpSecret(sealed, "wrong-password", SALT));
});

test("wrong salt fails authentication", () => {
  const sealed = sealTotpSecret(SECRET, PW, SALT);
  assert.throws(() => openTotpSecret(sealed, PW, "ffffffffffffffffffffffffffffffff"));
});

test("tampered ciphertext fails the GCM tag check", () => {
  const sealed = sealTotpSecret(SECRET, PW, SALT);
  const buf = Buffer.from(sealed, "base64");
  buf[buf.length - 1] ^= 0x01; // flip a bit in the tag
  assert.throws(() => openTotpSecret(buf.toString("base64"), PW, SALT));
});
