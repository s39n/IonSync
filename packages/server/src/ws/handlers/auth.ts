import { timingSafeEqual } from "node:crypto";
import type { AuthMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { expectedToken } from "../../crypto.js";

/**
 * Constant-time comparison of two hex token strings. A plain `a !== b`
 * short-circuits on the first differing character, which leaks — via response
 * timing — how many leading characters matched, letting an attacker recover the
 * token byte-by-byte. `timingSafeEqual` always reads both buffers fully.
 * It throws when lengths differ, so the length check both guards that and rejects
 * malformed (wrong-length) tokens up front without an early-exit timing tell.
 */
function tokensMatch(received: string, expected: string): boolean {
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function handleAuth(ctx: SyncContext, peer: SyncPeer, msg: AuthMsg): void {
  const want = expectedToken(peer.nonce, ctx.config.password);

  if (!tokensMatch(msg.token ?? "", want)) {
    peer.send({ type: "auth_error", message: "Invalid credentials" });
    peer.disconnect("Auth failed");
    return;
  }

  peer.authed = true;
  peer.deviceId = msg.deviceId;

  // Record device last_online
  ctx.db.touchDevice(msg.deviceId);

  // Persist the device name if the plugin sent one
  if (msg.deviceName) {
    ctx.db.setDeviceName(msg.deviceId, msg.deviceName);
  }

  peer.send({ type: "auth_ok" });

  log(ctx, `[auth] device "${msg.deviceId}" authenticated (peer ${peer.id})`);
}

function log(ctx: SyncContext, msg: string): void {
  if (ctx.config.logs.level >= 3) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    ctx.logBuffer.push(line);
    if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
  }
}
