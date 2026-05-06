/**
 * Handles a single-file `file_event` message — used for live sync when a file
 * changes while the client is connected, rather than a full initial sync.
 */
import type { FileEventMsg } from "@ionsync/protocol";
import { compareFiles } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";

export function handleFileEvent(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: FileEventMsg
): void {
  const { file } = msg;
  const serverFile = ctx.db.getFile(file.path);

  if (!serverFile) {
    // Server doesn't know this file — request upload if client has it active
    if (file.action === "active") {
      peer.pendingUploads.add(file.path);
      peer.send({ type: "file_event_result", path: file.path, result: "client_newer" });
    }
    return;
  }

  const result = compareFiles(file, serverFile);

  if (result === null) {
    peer.send({ type: "file_event_result", path: file.path, result: null });
    return;
  }

  if (result === "server_newer") {
    // Let client know so it can request the file
    peer.send({ type: "file_event_result", path: file.path, result: "server_newer" });
  } else {
    // client_newer — request upload
    peer.pendingUploads.add(file.path);
    peer.send({ type: "file_event_result", path: file.path, result: "client_newer" });
  }
}
