/**
 * IonSync End-to-End Encryption (E2EE)
 * Algorithm : AES-256-GCM via the browser-native crypto.subtle API
 *
 * Wire format for encrypted content:
 *   base64( MAGIC[8] + IV[12] + AES-GCM-ciphertext[N] )
 *
 *   MAGIC = ASCII "IONENCv1"  →  0x49 0x4F 0x4E 0x45 0x4E 0x43 0x76 0x31
 *   IV    = 12 random bytes, generated fresh for every encryption
 *
 * The MAGIC prefix lets any component (plugin, dashboard, server) detect
 * encrypted content without touching the wire protocol.  The first 8 chars
 * of the resulting base64 string are always "SU9ORU5D", which the dashboard
 * uses for a fast string-level check before base64-decoding anything.
 *
 * Key derivation:
 *   PBKDF2-SHA256, 100 000 iterations, fixed application-level salt.
 *   A fixed salt is intentional — all devices must derive the same AES key
 *   from the same user password in order to decrypt each other's files.
 *
 * SHA1 field:
 *   file.sha1 always contains SHA1 of the *plaintext*, not the ciphertext.
 *   This keeps compareFiles() working correctly for change detection.
 *   The server skips SHA1 upload-verification when it detects the magic
 *   header in the decoded upload buffer.
 */

/** 8-byte binary magic: ASCII "IONENCv1" */
export const E2EE_MAGIC = new Uint8Array([
  0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76, 0x31,
]);

/**
 * The first 8 chars of any base64-encoded encrypted blob are always
 * "SU9ORU5D" (base64 of the first 6 magic bytes, which are fixed).
 * Use this for a fast prefix check before decoding the full buffer.
 */
export const E2EE_BASE64_PREFIX = "SU9ORU5D";

const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 100_000;

// Fixed application-level salt — provides domain separation so the derived
// key can't be confused with keys for other apps, without requiring per-vault
// state that would break cross-device sync.
const PBKDF2_SALT = new TextEncoder().encode("IonSync-AES-GCM-v1-salt");

// ── Key derivation ──────────────────────────────────────────────────────────

/** Derives an AES-256-GCM CryptoKey from an encryption password using PBKDF2. */
export async function deriveKey(password: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ── Encrypt ─────────────────────────────────────────────────────────────────

/**
 * Encrypts raw plaintext bytes.
 * Returns a base64 string encoding: MAGIC[8] + IV[12] + ciphertext[N].
 */
export async function encryptToBase64(
  key: CryptoKey,
  plaintext: BufferSource
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  const out = new Uint8Array(
    E2EE_MAGIC.length + IV_BYTES + ciphertext.byteLength
  );
  out.set(E2EE_MAGIC, 0);
  out.set(iv, E2EE_MAGIC.length);
  out.set(new Uint8Array(ciphertext), E2EE_MAGIC.length + IV_BYTES);

  return Buffer.from(out).toString("base64");
}

// ── Detect ──────────────────────────────────────────────────────────────────

/**
 * Returns true when a base64 content string carries an E2EE-encrypted blob.
 * Uses a fast string prefix check — no decoding required.
 */
export function isEncryptedBase64(content: string): boolean {
  return content.startsWith(E2EE_BASE64_PREFIX);
}

// ── Decrypt ─────────────────────────────────────────────────────────────────

/**
 * Decrypts a base64 string produced by encryptToBase64.
 * Throws DOMException if the key is wrong or the data has been tampered with
 * (AES-GCM authentication tag mismatch).
 */
export async function decryptFromBase64(
  key: CryptoKey,
  content: string
): Promise<ArrayBuffer> {
  const buf = Buffer.from(content, "base64");
  const iv = buf.slice(E2EE_MAGIC.length, E2EE_MAGIC.length + IV_BYTES);
  const ciphertext = buf.slice(E2EE_MAGIC.length + IV_BYTES);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}
