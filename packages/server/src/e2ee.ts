/**
 * Server-side mirror of the plugin's E2EE wire format (see plugin Crypto.ts).
 *
 * Wire format: MAGIC[8] + IV[12] + ciphertext[N-16] + authTag[16]
 *   MAGIC = ASCII "IONENCv" + one version digit.
 *
 * The server never encrypts; it only needs to (a) detect that an upload/stored
 * blob is encrypted (to skip SHA1 verification and show a lock icon) and
 * (b) optionally decrypt for the dashboard export/preview feature.
 *
 * Iteration count is pinned per format version so blobs written by any plugin
 * build remain decryptable:
 *   v1 -> 100 000 iterations (legacy)
 *   v2 -> 600 000 iterations (current)
 */
import nodeCrypto from "node:crypto";

const MAGIC_PREFIX = Buffer.from([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76]); // "IONENCv"
const MAGIC_LEN = 8;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PBKDF2_SALT = Buffer.from("IonSync-AES-GCM-v1-salt");
const ITERATIONS_BY_VERSION: Record<number, number> = {
  1: 100_000,
  2: 600_000,
};

/** True when the buffer begins with our magic prefix (any version). */
export function isE2eeEncrypted(buf: Buffer): boolean {
  return (
    buf.length >= MAGIC_LEN &&
    buf.subarray(0, MAGIC_PREFIX.length).equals(MAGIC_PREFIX)
  );
}

/** Format version digit from the magic, or null if the buffer isn't ours. */
export function e2eeVersion(buf: Buffer): number | null {
  if (!isE2eeEncrypted(buf)) return null;
  return buf[MAGIC_PREFIX.length]! - 0x30;
}

/** Derives the AES-256 key for a given format version (raw 32 bytes). */
export function deriveE2eeKey(password: string, version: number): Buffer {
  const iterations = ITERATIONS_BY_VERSION[version];
  if (iterations === undefined) {
    throw new Error(`IonSync E2EE: unsupported format version ${version}`);
  }
  return nodeCrypto.pbkdf2Sync(password, PBKDF2_SALT, iterations, 32, "sha256");
}

/**
 * Returns a decrypt function bound to `password` that derives a key per format
 * version on first use and caches it. This keeps bulk export cheap (one PBKDF2
 * per version, not per file) while transparently handling a mix of v1 and v2
 * blobs. Throws on tampered data, wrong password, or unknown version.
 */
export function makeE2eeDecryptor(password: string): (buf: Buffer) => Buffer {
  const keys = new Map<number, Buffer>();
  return (buf: Buffer): Buffer => {
    const version = e2eeVersion(buf);
    if (version === null) {
      throw new Error("IonSync E2EE: buffer is not encrypted");
    }
    let key = keys.get(version);
    if (!key) {
      key = deriveE2eeKey(password, version);
      keys.set(version, key);
    }
    const iv = buf.subarray(MAGIC_LEN, MAGIC_LEN + IV_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const ciphertext = buf.subarray(MAGIC_LEN + IV_BYTES, buf.length - TAG_BYTES);
    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  };
}
