import { createHash } from "node:crypto";

/**
 * Computes the auth token the client is expected to send.
 * Formula matches v1: SHA-256( nonce[0..16] + password + nonce[16..] )
 * Using the same scheme keeps the Obsidian plugin compatible when rewritten.
 */
export function expectedToken(nonce: string, password: string): string {
  const input = nonce.slice(0, 16) + password + nonce.slice(16);
  return createHash("sha256").update(input).digest("hex");
}

export function sha1(data: Buffer | string): string {
  return createHash("sha1").update(data).digest("hex");
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
