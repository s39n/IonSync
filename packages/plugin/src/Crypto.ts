/**
 * IonSync End-to-End Encryption (E2EE)
 * Algorithm : AES-256-GCM via the browser-native crypto.subtle API
 *
 * Wire format for encrypted content:
 *   base64( MAGIC[8] + IV[12] + AES-GCM-ciphertext[N] )
 *
 *   MAGIC = ASCII "IONENCv<N>"  ->  0x49 0x4F 0x4E 0x45 0x4E 0x43 0x76 0x3<N>
 *           where the final byte is the format version digit.
 *   IV    = 12 random bytes, generated fresh for every encryption
 *
 * The MAGIC prefix lets any component (plugin, dashboard, server) detect
 * encrypted content without touching the wire protocol.  The first 8 chars
 * of the resulting base64 string are always "SU9ORU5D" (base64 of the fixed
 * first 6 bytes "IONENC"), which the dashboard uses for a fast string-level
 * check before base64-decoding anything. This holds for every version because
 * only the 8th byte changes.
 *
 * Key derivation:
 *   PBKDF2-SHA256 with a fixed application-level salt. The iteration count is
 *   pinned to the format version embedded in the magic so files written by
 *   older builds stay decryptable forever:
 *     v1 -> 100 000 iterations  (legacy)
 *     v2 -> 600 000 iterations  (current; OWASP 2023 floor for PBKDF2-SHA256)
 *   New content is always written at WRITE_VERSION; decryption derives the key
 *   for whatever version the blob declares. Changing iterations changes the
 *   derived key, so bumping WITHOUT versioning would make every existing
 *   ciphertext undecryptable -- hence the per-version derivation below.
 *   A fixed salt is intentional -- all devices must derive the same AES key
 *   from the same user password in order to decrypt each other's files.
 *
 * SHA1 field:
 *   file.sha1 always contains SHA1 of the *plaintext*, not the ciphertext.
 *   This keeps compareFiles() working correctly for change detection.
 *   The server skips SHA1 upload-verification when it detects the magic
 *   header in the decoded upload buffer.
 */

/** Magic length in bytes: ASCII "IONENCv" + one version digit. */
const MAGIC_LEN = 8;

/** Fixed first 7 magic bytes: ASCII "IONENCv" (the 8th byte is the version). */
const MAGIC_PREFIX = new Uint8Array([0x49, 0x4f, 0x4e, 0x45, 0x4e, 0x43, 0x76]);

/** Format version stamped into newly-encrypted content. */
export const WRITE_VERSION = 2;

/**
 * PBKDF2 iteration count per format version. Pinning iterations to the version
 * keeps older ciphertext decryptable: the key is re-derived on decrypt, so the
 * count used to encrypt must be recoverable from the blob itself.
 */
const ITERATIONS_BY_VERSION: Record<number, number> = {
  1: 100_000, // legacy
  2: 600_000, // current — OWASP 2023 floor for PBKDF2-SHA256
};

/** 8-byte binary magic for the current WRITE_VERSION ("IONENCv2"). */
export const E2EE_MAGIC = magicForVersion(WRITE_VERSION);

/** Builds the 8-byte magic for a given version (e.g. 2 -> "IONENCv2"). */
function magicForVersion(version: number): Uint8Array {
  const m = new Uint8Array(MAGIC_LEN);
  m.set(MAGIC_PREFIX, 0);
  m[MAGIC_PREFIX.length] = 0x30 + version; // ASCII digit
  return m;
}

/**
 * The first 8 chars of any base64-encoded encrypted blob are always
 * "SU9ORU5D" (base64 of the first 6 magic bytes, which are fixed across every
 * version). Use this for a fast prefix check before decoding the full buffer.
 */
export const E2EE_BASE64_PREFIX = "SU9ORU5D";

const IV_BYTES = 12;

// Fixed application-level salt -- provides domain separation so the derived
// key cannot be confused with keys for other apps, without requiring per-vault
// state that would break cross-device sync.
const PBKDF2_SALT = new TextEncoder().encode("IonSync-AES-GCM-v1-salt");

// Key derivation
//
// PBKDF2 (especially at 600k iterations) is deliberately expensive, so we cache
// derived keys by `${version}\0${password}`. Without this, every file
// encrypt/decrypt would pay the full derivation cost; with it, a session pays
// it once per (version, password) pair. CryptoKey is non-extractable, so this
// cache holds no raw key material.
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Derives an AES-256-GCM CryptoKey from an encryption password using PBKDF2.
 * `version` selects the iteration count; it defaults to the current
 * WRITE_VERSION (used for encryption). Decryption passes the blob's own
 * version so legacy files derive with their original iteration count.
 */
export async function deriveKey(
  password: string,
  version: number = WRITE_VERSION
): Promise<CryptoKey> {
  const iterations = ITERATIONS_BY_VERSION[version];
  if (iterations === undefined) {
    throw new Error(`IonSync E2EE: unsupported format version ${version}`);
  }
  const cacheKey = `${version}\0${password}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
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
        iterations,
        hash: "SHA-256",
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  })();
  // Cache the promise so concurrent callers share one derivation; drop it on
  // failure so a transient error doesn't poison the cache.
  keyCache.set(cacheKey, promise);
  promise.catch(() => keyCache.delete(cacheKey));
  return promise;
}

// Encrypt

/**
 * Encrypts raw plaintext bytes.
 * Returns the raw blob bytes: MAGIC[8] + IV[12] + ciphertext[N].
 * Preferred on the binary-frame path — no base64 pass at all.
 */
export async function encryptToBytes(
  key: CryptoKey,
  plaintext: BufferSource
): Promise<Uint8Array> {
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
  return out;
}

/**
 * Encrypts raw plaintext bytes.
 * Returns a base64 string encoding: MAGIC[8] + IV[12] + ciphertext[N].
 * Retained for the legacy base64-in-JSON wire (old server without the
 * "binary_frames" cap).
 */
export async function encryptToBase64(
  key: CryptoKey,
  plaintext: BufferSource
): Promise<string> {
  const out = await encryptToBytes(key, plaintext);

  // Use btoa (native WebAPI) -- Buffer is not available on Android WebView.
  // Chunk via String.fromCharCode.apply rather than a per-byte `+=` rope: the
  // per-byte loop is ~10× slower and holds several MB of transient string on
  // large files. Chunk stays under the engine's argument-count ceiling.
  let binary = "";
  const CHUNK = 0x8000; // 32 KiB
  for (let i = 0; i < out.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      out.subarray(i, i + CHUNK) as unknown as number[]
    );
  }
  return btoa(binary);
}

// Detect

/**
 * Returns true when a base64 content string carries an E2EE-encrypted blob.
 * Uses a fast string prefix check -- no decoding required.
 */
export function isEncryptedBase64(content: string): boolean {
  return content.startsWith(E2EE_BASE64_PREFIX);
}

// Decrypt

/**
 * Reads the format version digit from the magic header of a decoded blob.
 * Returns null if the prefix doesn't match (not our ciphertext).
 */
function readVersion(bytes: Uint8Array): number | null {
  if (bytes.length < MAGIC_LEN) return null;
  for (let i = 0; i < MAGIC_PREFIX.length; i++) {
    if (bytes[i] !== MAGIC_PREFIX[i]) return null;
  }
  return bytes[MAGIC_PREFIX.length]! - 0x30;
}

/**
 * Decrypts a base64 string produced by encryptToBase64. Derives the AES key
 * from `password` using the iteration count for the version stamped in the
 * blob, so both legacy (v1/100k) and current (v2/600k) content decrypt with the
 * same call. Throws if the password is wrong, the data has been tampered with
 * (AES-GCM tag mismatch), or the version is unknown.
 *
 * Uses atob (native WebAPI) instead of Buffer.from(..., "base64") so behaviour
 * is identical on desktop Electron, iOS WebKit, and Android WebView.
 * The Buffer polyfill on Obsidian mobile produces typed-array views whose
 * backing-ArrayBuffer layout confuses WebCrypto on both iOS and Android.
 */
export async function decryptFromBase64(
  content: string,
  password: string
): Promise<ArrayBuffer> {
  const binary = atob(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const version = readVersion(bytes);
  if (version === null) {
    throw new Error("IonSync E2EE: content is not an encrypted blob");
  }
  const key = await deriveKey(password, version);

  const iv = bytes.slice(MAGIC_LEN, MAGIC_LEN + IV_BYTES);
  const ciphertext = bytes.slice(MAGIC_LEN + IV_BYTES);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}
