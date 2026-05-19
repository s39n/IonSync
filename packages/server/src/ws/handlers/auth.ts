import type { AuthMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import { expectedToken } from "../../crypto.js";

export function handleAuth(ctx: SyncContext, peer: SyncPeer, msg: AuthMsg): void {
  const want = expectedToken(peer.nonce, ctx.config.password);

  if (msg.token !== want) {
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
