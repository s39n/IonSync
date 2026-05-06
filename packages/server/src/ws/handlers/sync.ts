import type { SyncMsg, FileEntry } from "@ionsync/protocol";
import { compareFiles } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";

/** Max files requested from client simultaneously — bounds server-side buffer memory. */
const UPLOAD_BATCH = 10;

export function handleSync(ctx: SyncContext, peer: SyncPeer, msg: SyncMsg): void {
  // On the first chunk of a sync session, initialise state and start accumulating.
  // Use a local variable so TypeScript can track narrowing across the function.
  let clientMap: Map<string, FileEntry>;
  if (!peer.syncClientMap) {
    clientMap = new Map();
    peer.syncClientMap = clientMap;
    peer.pendingUploads.clear();
    peer.uploadQueue = [];
    peer.pushQueue = [];
    peer.syncSessionActive = true;
  } else {
    clientMap = peer.syncClientMap;
  }

  // Accumulate client file entries across chunks.
  for (const f of msg.files) {
    clientMap.set(f.path, f);
  }

  // msg.last is undefined for old single-chunk clients → treat as true (backward-compat).
  if (msg.last === false) return;

  // Final chunk received — now do the full comparison and populate queues.
  delete peer.syncClientMap;

  const serverFiles = ctx.db.getAllFiles();
  const serverMap = new Map<string, FileEntry>(serverFiles.map((f: FileEntry) => [f.path, f]));

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

  // Request first upload batch — rest wait in uploadQueue.
  for (const path of toRequest) {
    if (peer.pendingUploads.size < UPLOAD_BATCH) {
      peer.pendingUploads.add(path);
      peer.send({ type: "file_event_result", path, result: "client_newer" });
    } else {
      peer.uploadQueue.push(path);
    }
  }

  // Drain server→client pushes with callback-based backpressure.
  drainPushQueue(ctx, peer);
}

/**
 * Send one server-newer file, then recurse inside the ws.send() callback.
 * The callback fires only after the payload has been flushed to the TCP socket,
 * so the send buffer never accumulates more than one large file at a time.
 */
export function drainPushQueue(ctx: SyncContext, peer: SyncPeer): void {
  if (peer.pushQueue.length === 0) {
    checkSyncDone(peer);
    return;
  }
  if (peer.ws.readyState !== peer.ws.OPEN) return;

  const file = peer.pushQueue.shift()!;
  let content = "";
  if (file.action === "active" && file.fileType === "file") {
    const buf = ctx.storage.readLatest(file.path);
    content = buf ? buf.toString("base64") : "";
  }

  const payload = JSON.stringify({ type: "file_push" as const, file, content });
  peer.ws.send(payload, (err?: Error) => {
    if (err) return; // connection closed — abandon the queue
    drainPushQueue(ctx, peer);
  });
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
