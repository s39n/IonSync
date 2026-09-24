/**
 * Ed25519 signing/verification for the plugin auto-update bundle.
 *
 * Threat: the server pushes plugin JS that the client hot-reloads with full
 * vault + filesystem access (SECURITY.md #4). Over plain ws:// a MITM or a
 * compromised server could push arbitrary code — remote code execution.
 *
 * Fix: the update bundle (main.js) is signed at BUILD time with a private key
 * the running server never holds; the plugin pins the matching PUBLIC key and
 * verifies before applying. This is transport-independent — it protects both
 * ws:// and wss:// — so it never forces users onto TLS. A rogue server cannot
 * forge a signature, and stripping it fails closed (see the plugin's apply path).
 *
 * Keys are raw 32-byte ed25519, hex-encoded. Signatures are base64. ed25519
 * sign/verify are deterministic and dependency-free (no RNG), so this runs the
 * same on desktop, mobile, and the Node build.
 */
import { ed25519 } from "@noble/curves/ed25519.js";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// atob/btoa only (no Node Buffer): available in desktop Electron, mobile
// WebViews, and Node 20, and behaves identically across all three. The Buffer
// polyfill on Obsidian mobile produces typed-array views that confuse WebCrypto
// (same rationale as Crypto.decryptFromBase64).
function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sign bundle bytes with a raw 32-byte ed25519 private key (hex). Returns a
 *  base64 signature. Build-time only. */
export function signPluginBundle(bundle: Uint8Array, privateKeyHex: string): string {
  return bytesToB64(ed25519.sign(bundle, hexToBytes(privateKeyHex)));
}

/** Verify bundle bytes against a base64 signature and a raw 32-byte ed25519
 *  public key (hex). Returns false on ANY error — fail closed. */
export function verifyPluginBundle(
  bundle: Uint8Array,
  signatureB64: string | undefined | null,
  publicKeyHex: string,
): boolean {
  if (!signatureB64) return false;
  try {
    return ed25519.verify(b64ToBytes(signatureB64), bundle, hexToBytes(publicKeyHex));
  } catch {
    return false;
  }
}

// ── Whole-update signature (all files, not just main.js) ────────────────────
//
// The legacy signature above covers main.js only, but an update carries
// several files and the plugin writes them all into its own folder. An
// unsigned sidecar (e.g. a forged `data.json`) could rewrite the plugin's
// settings — point it at another server or switch E2EE off. So the update is
// now restricted to a fixed allowlist of names, and the whole set is signed.

/** The only file names an auto-update may write. Anything else is dropped. */
export const UPDATE_FILE_NAMES = ["main.js", "manifest.json", "styles.css"] as const;

const FILES_SIG_DOMAIN = "ionsync-update-files-v1";

/**
 * Canonical byte string signed for a whole update: a domain tag, then each
 * allowlisted file (sorted by name) as name, NUL, 4-byte big-endian length,
 * bytes. Length-prefixing makes the encoding unambiguous. Files outside the
 * allowlist are ignored; an allowlisted name that is absent is encoded with
 * length 0xFFFFFFFF so "missing" can never be confused with "empty".
 */
export function updateFilesMessage(files: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const byName = new Map(files.map((f) => [f.name, f.bytes]));
  const parts: Uint8Array[] = [enc.encode(FILES_SIG_DOMAIN + "\n")];
  for (const name of [...UPDATE_FILE_NAMES].sort()) {
    const bytes = byName.get(name);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes ? bytes.length : 0xffffffff);
    parts.push(enc.encode(name), new Uint8Array([0]), len);
    if (bytes) parts.push(bytes);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Sign the full allowlisted file set. Build-time only. */
export function signPluginFiles(files: ReadonlyArray<{ name: string; bytes: Uint8Array }>, privateKeyHex: string): string {
  return signPluginBundle(updateFilesMessage(files), privateKeyHex);
}

/** Verify the full allowlisted file set. Returns false on any error. */
export function verifyPluginFiles(
  files: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
  signatureB64: string | undefined | null,
  publicKeyHex: string,
): boolean {
  return verifyPluginBundle(updateFilesMessage(files), signatureB64, publicKeyHex);
}
