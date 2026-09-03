/**
 * At-rest encryption for the TOTP (2FA) secret (SECURITY.md #10).
 *
 * The 2FA seed was stored as plaintext in the settings table, so anyone who
 * obtained the SQLite file — or one of the automated backups — could clone the
 * authenticator. We now seal it with AES-256-GCM under a key derived from the
 * admin password (which the running server already holds) and the per-install
 * salt. A leaked DB or backup therefore no longer exposes the seed; an attacker
 * would also need the admin password, at which point the second factor is moot.
 *
 * The stored form is base64 of: MAGIC[5] + IV[12] + ciphertext + GCM-tag[16].
 * `openTotpSecret` returns any value lacking the magic verbatim, so a legacy
 * plaintext secret keeps working until it is re-sealed (on the next enable, or
 * by the one-time startup migration).
 */
import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const MAGIC = Buffer.from("TSEC1", "utf8"); // marks a sealed TOTP secret
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERS = 200_000;

function deriveKey(password: string, saltHex: string): Buffer {
  // Domain-separate from any other use of the per-install salt.
  const salt = Buffer.concat([Buffer.from(saltHex, "hex"), Buffer.from("totp-secret-v1", "utf8")]);
  return pbkdf2Sync(password, salt, PBKDF2_ITERS, 32, "sha256");
}

/** Returns true when a stored value is a sealed (encrypted) TOTP secret. */
export function isSealed(stored: string): boolean {
  let buf: Buffer;
  try { buf = Buffer.from(stored, "base64"); } catch { return false; }
  return buf.length >= MAGIC.length + IV_LEN + TAG_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Encrypt a TOTP secret for storage. */
export function sealTotpSecret(plaintext: string, password: string, saltHex: string): string {
  const key = deriveKey(password, saltHex);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, ct, tag]).toString("base64");
}

/**
 * Decrypt a stored TOTP secret. A value without the magic prefix is treated as
 * a legacy plaintext secret and returned unchanged (forward-compatible read).
 * Throws only if a sealed blob fails authentication (wrong key / tampering).
 */
export function openTotpSecret(stored: string, password: string, saltHex: string): string {
  if (!isSealed(stored)) return stored; // legacy plaintext
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(MAGIC.length + IV_LEN, buf.length - TAG_LEN);
  const key = deriveKey(password, saltHex);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
