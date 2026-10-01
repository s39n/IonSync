/**
 * IonSync E2EE for Node — byte-compatible with plugin/src/Crypto.ts.
 *
 *   blob = MAGIC[8] ("IONENCv<N>") + IV[12] + AES-256-GCM ciphertext + tag[16]
 *
 * PBKDF2-SHA256, iterations and salt pinned per format version (see CLAUDE.md,
 * "E2EE format versioning"). NEVER change an existing version's parameters:
 * the key is re-derived on every decrypt.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const MAGIC_PREFIX = Buffer.from("IONENCv", "ascii");
const MAGIC_LEN = 8;
const IV_LEN = 12;
const TAG_LEN = 16;
const GLOBAL_SALT = Buffer.from("IonSync-AES-GCM-v1-salt", "utf8");

const ITERATIONS_BY_VERSION: Record<number, number> = {
  1: 100_000,
  2: 600_000,
  3: 600_000, // per-install salt
};

/** Format version of an encrypted blob, or null when it is not one of ours. */
export function blobVersion(bytes: Uint8Array): number | null {
  if (bytes.length < MAGIC_LEN) return null;
  for (let i = 0; i < MAGIC_PREFIX.length; i++) {
    if (bytes[i] !== MAGIC_PREFIX[i]) return null;
  }
  return bytes[MAGIC_PREFIX.length]! - 0x30;
}

export class E2ee {
  private readonly keys = new Map<number, Buffer>();
  private installSalt: Buffer | null = null;

  constructor(private readonly password: string) {}

  /** Per-install salt from the server's auth_ok (hex). Needed for v3. */
  setInstallSalt(hex: string): void {
    const salt = Buffer.from(hex, "hex");
    if (this.installSalt && this.installSalt.equals(salt)) return;
    this.installSalt = salt;
    this.keys.delete(3);
  }

  supports(version: number): boolean {
    if (ITERATIONS_BY_VERSION[version] === undefined) return false;
    return version < 3 || this.installSalt !== null;
  }

  private key(version: number): Buffer {
    const cached = this.keys.get(version);
    if (cached) return cached;
    const iterations = ITERATIONS_BY_VERSION[version];
    if (iterations === undefined) throw new Error(`unsupported E2EE format version ${version}`);
    let salt: Buffer = GLOBAL_SALT;
    if (version >= 3) {
      if (!this.installSalt) throw new Error("per-install salt unavailable for v3");
      salt = this.installSalt;
    }
    const key = pbkdf2Sync(Buffer.from(this.password, "utf8"), salt, iterations, 32, "sha256");
    this.keys.set(version, key);
    return key;
  }

  encrypt(plaintext: Uint8Array, version: number): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key(version), iv);
    const magic = Buffer.concat([MAGIC_PREFIX, Buffer.from([0x30 + version])]);
    return Buffer.concat([magic, iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  }

  /** Throws on a wrong password, tampering, or an unknown version. */
  decrypt(blob: Uint8Array): Buffer {
    const version = blobVersion(blob);
    if (version === null) throw new Error("not an encrypted blob");
    if (blob.length < MAGIC_LEN + IV_LEN + TAG_LEN) throw new Error("encrypted blob is truncated");
    const iv = blob.subarray(MAGIC_LEN, MAGIC_LEN + IV_LEN);
    const body = blob.subarray(MAGIC_LEN + IV_LEN, blob.length - TAG_LEN);
    const tag = blob.subarray(blob.length - TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", this.key(version), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}
