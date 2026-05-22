import type { SyncMsg, FileEntry } from "@ionsync/protocol";
import { compareFiles } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";

/** Max files requested from client simultaneously — bounds server-side buffer memory. */
const UPLOAD_BATCH = 1;

function logInfo(ctx: SyncContext, msg: string): void {
  if (ctx.config.logs.level >= 3) pushLog(ctx, msg);
}
function logWarn(ctx: SyncContext, msg: string): void {
  if (ctx.config.logs.level >= 2) pushLog(ctx, `[WARN] ${msg}`);
}
function pushLog(ctx: SyncContext, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  ctx.logBuffer.push(line);
  if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
}

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

  // Pre-fetch received_at for all deleted files so we can correctly resolve
  // the re-add case without an extra DB round-trip per file.
  const deletedReceivedAt = ctx.db.getDeletedReceivedAt();

  const toRequest: string[] = [];

  for (const serverFile of serverFiles) {
    const clientFile = clientMap.get(serverFile.path);
    if (!clientFile) {
      if (serverFile.action === "active") peer.pushQueue.push(serverFile);
      continue;
    }

    // Special case: server has this file marked as "deleted" but the client is
    // sending it as "active".  This happens when the user deletes a file via
    // the dashboard and then re-adds it to their vault.
    //
    // Standard mtime comparison fails here because the dashboard delete stamps
    // mtime = Date.now(), which always beats the original file mtime.  Instead
    // we compare against received_at (when the deletion was recorded):
    //   client.mtime > received_at  -> file was re-added AFTER the deletion -> client wins
    //   client.mtime <= received_at -> client just hasn't received the deletion yet -> propagate it
    if (serverFile.action === "deleted" && clientFile.action === "active") {
      const receivedAt = deletedReceivedAt.get(serverFile.path) ?? serverFile.mtime;
      if (clientFile.mtime > receivedAt) {
        toRequest.push(serverFile.path);
        logInfo(ctx, `[Sync] ${peer.deviceId} client_newer (re-add after delete): ${serverFile.path} (clientMtime=${clientFile.mtime} > receivedAt=${receivedAt})`);
      } else {
        peer.pushQueue.push(serverFile); // propagate deletion to stale client
        logWarn(ctx, `[Sync] PUSHING DELETE to ${peer.deviceId}: ${serverFile.path} (clientMtime=${clientFile.mtime} <= receivedAt=${receivedAt})`);
      }
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

  // Sync decision summary — helps diagnose spurious-delete situations.
  const deletesPushed = peer.pushQueue.filter(f => f.action === "deleted").length;
  logInfo(ctx, `[Sync] ${peer.deviceId} summary: push=${peer.pushQueue.length} (${deletesPushed} deletes), request=${toRequest.length}, clientFiles=${clientMap.size}, serverFiles=${serverFiles.length}`);
  if (deletesPushed > 0) {
    logWarn(ctx, `[Sync] WARNING: pushing ${deletesPushed} deletion(s) to ${peer.deviceId}:`);
    for (const f of peer.pushQueue.filter(f => f.action === "deleted")) {
      logWarn(ctx, `  DELETE → ${peer.deviceId}: ${f.path}`);
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
    
    // Check if the WebSocket buffer is choked (e.g., > 10MB)
    if (peer.ws.bufferedAmount > 10 * 1024 * 1024) {
      const waitInterval = setInterval(() => {
        // Wait for buffer to drain below 2MB
        if (peer.ws.bufferedAmount < 2 * 1024 * 1024) {
          clearInterval(waitInterval);
          setImmediate(() => drainPushQueue(ctx, peer)); // Yield to GC
        }
      }, 50);
    } else {
      // Yield to GC immediately before reading the next file
      setImmediate(() => drainPushQueue(ctx, peer));
    }
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
  // 1. Collect targets first
  const targets: SyncPeer[] = [];
  for (const peer of ctx.peers.values()) {
    if (peer.id === sourcePeer.id) continue;
    if (!peer.authed || !peer.autoSync) continue;
    if (peer.ws.readyState === peer.ws.OPEN) {
      targets.push(peer);
    }
  }

  // 2. Bail early if no targets (saves a disk read)
  if (targets.length === 0) return;

  // 3. Read and stringify only ONCE
  let content = "";
  if (file.action === "active" && file.fileType === "file") {
    // ✅ 1. Check size before reading
    const sizeBytes = ctx.storage.getSizeLatest(file.path) ?? 0;
    const limitBytes = ctx.config.maxFileSizeMb * 1024 * 1024;

    if (sizeBytes > limitBytes) {
      console.warn(`[Sync] Skipping push for ${file.path} (${(sizeBytes / 1024 / 1024).toFixed(2)}MB). Exceeds ${ctx.config.maxFileSizeMb}MB limit.`);
      // We still send the file metadata, but we omit the content so the client 
      // knows the file exists but doesn't crash the server downloading it.
      content = ""; 
    } else {
      // Safe to read
      const buf = ctx.storage.readLatest(file.path);
      content = buf ? buf.toString("base64") : "";
    }
  }

  const payload = JSON.stringify({ type: "file_push" as const, file, content });

  // 4. Broadcast raw string directly
  if (file.action === "deleted") {
    logWarn(ctx, `[Broadcast] DELETE for ${file.path} → ${targets.length} peer(s): ${targets.map(p => p.deviceId).join(", ")}`);
  }
  // 4. Broadcast raw string directly
  for (const peer of targets) {
    peer.ws.send(payload);
  }
}