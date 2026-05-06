import type { SyncMsg, FileEntry } from "@ionsync/protocol";
import { compareFiles } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";

/** Max files requested from client simultaneously — bounds server-side buffer memory. */
const UPLOAD_BATCH = 10;

export function handleSync(ctx: SyncContext, peer: SyncPeer, msg: SyncMsg): void {
  const clientMap = new Map<string, FileEntry>(msg.files.map((f: FileEntry) => [f.path, f]));
  const serverFiles = ctx.db.getAllFiles();
  const serverMap = new Map<string, FileEntry>(serverFiles.map((f: FileEntry) => [f.path, f]));

  peer.pendingUploads.clear();
  peer.uploadQueue = [];
  peer.pushQueue = [];
  peer.syncSessionActive = true;

  const toRequest: string[] = [];

  for (const serverFile of serverFiles) {
    const clientFile = clientMap.get(serverFile.path);
    if (!clientFile) {
      if (serverFile.action === "active") peer.pushQueue.push(serverFile);
      continue;
    }
    const result = compareFiles(clientFile, serverFile);
    if (result === null) continue;
    if (result === "server_newer") {
      peer.pushQueue.push(serverFile);
    } else {
      toRequest.push(serverFile.path);
    }
  }

  for (const [filePath, clientFile] of clientMap) {
    if (!serverMap.has(filePath) && clientFile.action === "active") {
      toRequest.push(filePath);
    }
  }

  // Request first upload batch — rest wait in uploadQueue
  for (const path of toRequest) {
    if (peer.pendingUploads.size < UPLOAD_BATCH) {
      peer.pendingUploads.add(path);
      peer.send({ type: "file_event_result", path, result: "client_newer" });
    } else {
      peer.uploadQueue.push(path);
    }
  }

  // Drain pushes one-at-a-time via setImmediate so the GC can breathe
  drainPushQueue(ctx, peer);
}

/** Read and send one server-newer file per event-loop tick. */
export function drainPushQueue(ctx: SyncContext, peer: SyncPeer): void {
  if (peer.pushQueue.length === 0) {
    checkSyncDone(peer);
    return;
  }
  const file = peer.pushQueue.shift()!;
  pushFile(ctx, peer, file);
  setImmediate(() => drainPushQueue(ctx, peer));
}

/** Send sync_done once all uploads and server-side pushes are finished. */
export function checkSyncDone(peer: SyncPeer): void {
  if (
    peer.syncSessionActive &&
    peer.pendingUploads.size === 0 &&
    peer.uploadQueue.length === 0 &&
    peer.pushQueue.length === 0
  ) {
    peer.syncSessionActive = false;
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
