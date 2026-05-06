import type { SyncMsg, FileEntry } from "@ionsync/protocol";
import { compareFiles } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";

export function handleSync(ctx: SyncContext, peer: SyncPeer, msg: SyncMsg): void {
  const clientMap = new Map<string, FileEntry>(msg.files.map((f: FileEntry) => [f.path, f]));
  const serverFiles = ctx.db.getAllFiles();
  const serverMap = new Map<string, FileEntry>(serverFiles.map((f: FileEntry) => [f.path, f]));

  peer.pendingUploads.clear();

  // Files the server knows about
  for (const serverFile of serverFiles) {
    const clientFile = clientMap.get(serverFile.path);

    if (!clientFile) {
      // Server has it, client doesn't know about it — push if active
      if (serverFile.action === "active") {
        pushFile(ctx, peer, serverFile);
      }
      continue;
    }

    const result = compareFiles(clientFile, serverFile);
    if (result === null) continue;

    if (result === "server_newer") {
      pushFile(ctx, peer, serverFile);
    } else {
      peer.pendingUploads.add(serverFile.path);
      peer.send({ type: "file_event_result", path: serverFile.path, result: "client_newer" });
    }
  }

  // Files client has that server has never seen
  for (const [filePath, clientFile] of clientMap) {
    if (!serverMap.has(filePath) && clientFile.action === "active") {
      peer.pendingUploads.add(filePath);
      peer.send({ type: "file_event_result", path: filePath, result: "client_newer" });
    }
  }

  if (peer.pendingUploads.size === 0) {
    peer.send({ type: "sync_done" });
  }
}

function pushFile(ctx: SyncContext, peer: SyncPeer, file: FileEntry): void {
  let content = "";
  if (file.action === "active" && file.fileType === "file") {
    const buf = ctx.storage.readLatest(file.path);
    content = buf ? buf.toString("base64") : "";
  }
  peer.send({ type: "file_push", file, content });
}

export function broadcastToPeers(ctx: SyncContext, sourcePeer: SyncPeer, file: FileEntry): void {
  let content = "";
  if (file.action === "active" && file.fileType === "file") {
    const buf = ctx.storage.readLatest(file.path);
    content = buf ? buf.toString("base64") : "";
  }

  for (const peer of ctx.peers.values()) {
    if (peer.id === sourcePeer.id) continue;
    if (!peer.authed || !peer.autoSync) continue;
    peer.send({ type: "file_push", file, content });
  }
}
