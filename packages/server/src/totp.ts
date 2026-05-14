import { createHmac, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";

// ── Base32 helpers ──────────────────────────────────────────────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(byteCount = 20): string {
  const buf = randomBytes(byteCount);
  let result = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_CHARS[(value >> bits) & 31];
    }
  }
  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 31];
  }
  return result;
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/\s/g, "").replace(/=+$/, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

// ── HOTP / TOTP ──────────────────────────────────────────────────────────────

function hotp(key: Buffer, counter: bigint): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[19]! & 0x0f;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff)) %
    1_000_000;
  return code.toString().padStart(6, "0");
}

/**
 * Verify a 6-digit TOTP token against `secret`.
 * Accepts codes from ±windowSteps time-steps (each step = 30 s) to tolerate
 * minor clock skew between the server and the authenticator app.
 */
export function verifyTOTP(secret: string, token: string, windowSteps = 1): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const key = base32Decode(secret);
  const T = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (let i = -windowSteps; i <= windowSteps; i++) {
    if (hotp(key, T + BigInt(i)) === token) return true;
  }
  return false;
}

/**
 * Build an `otpauth://totp/` URI suitable for rendering as a QR code.
 */
export function totpUri(secret: string, issuer = "IonSync", account = "dashboard"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return (
    `otpauth://totp/${label}` +
    `?secret=${secret}` +
    `&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=6&period=30`
  );
}

// ── Pending login tokens (in-memory, TTL 5 min) ──────────────────────────────

interface PendingToken {
  expiresAt: number;
}

const pendingTokens = new Map<string, PendingToken>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Create a short-lived token to bridge the two-step login. */
export function createPendingToken(): string {
  // Prune expired tokens lazily
  const now = Date.now();
  for (const [k, v] of pendingTokens) {
    if (v.expiresAt <= now) pendingTokens.delete(k);
  }
  const token = randomUUID();
  pendingTokens.set(token, { expiresAt: now + TOKEN_TTL_MS });
  return token;
}

/** Consume a pending token — returns true if it existed and was not expired. */
export function consumePendingToken(token: string): boolean {
  const entry = pendingTokens.get(token);
  if (!entry) return false;
  pendingTokens.delete(token);
  return entry.expiresAt > Date.now();
}
