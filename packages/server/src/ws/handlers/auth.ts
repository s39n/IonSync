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

/**
 * Device IDs are plugin-generated UUIDs (but historically free-form). They
 * flow into settings keys, log lines, dashboard HTML, and — truncated — into
 * "(Conflicted Copy … <id>)" file paths, so an attacker-chosen string must not
 * be able to smuggle path separators, dots, or markup. Allow only a
 * conservative identifier charset.
 */
const DEVICE_ID_RE = /^[0-9A-Za-z_-]{1,64}$/;

/**
 * Display names are user-typed: drop control characters (codepoints < 0x20 and
 * DEL), then cap the length. Rendered into dashboard HTML (escaped there too —
 * defence in depth).
 */
function sanitizeDeviceName(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 32 && c !== 127) out += ch;
  }
  return out.trim().slice(0, 64);
}

export function handleAuth(ctx: SyncContext, peer: SyncPeer, msg: AuthMsg): void {
  const want = expectedToken(peer.nonce, ctx.config.password);

  if (!tokensMatch(msg.token ?? "", want)) {
    peer.send({ type: "auth_error", message: "Invalid credentials" });
    peer.disconnect("Auth failed");
    return;
  }

  if (typeof msg.deviceId !== "string" || !DEVICE_ID_RE.test(msg.deviceId)) {
    peer.send({ type: "auth_error", message: "Invalid device ID" });
    peer.disconnect("Auth failed");
    return;
  }

  peer.authed = true;
  peer.deviceId = msg.deviceId;

  // Record device last_online
  ctx.db.touchDevice(msg.deviceId);

  // Persist the device name if the plugin sent one
  if (msg.deviceName) {
    const clean = sanitizeDeviceName(msg.deviceName);
    if (clean) ctx.db.setDeviceName(msg.deviceId, clean);
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
