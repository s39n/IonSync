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

function bytesToB64(b: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b).toString("base64");
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
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
