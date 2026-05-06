import type { FileHistoryRequestMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";

export function handleFileHistory(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: FileHistoryRequestMsg
): void {
  const versions = ctx.db.getVersions(msg.path);
  peer.send({ type: "file_history_response", path: msg.path, versions });
}
