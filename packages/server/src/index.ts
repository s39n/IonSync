import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { diff_match_patch } from "diff-match-patch";
import { BackgroundSyncReq, ClientMsg } from "@ionsync/protocol";
// Import your custom context/DB logic here
// import { initContext } from "./context"; 

// ─── SERVER CONTEXT SETUP ──────────────────────────────────────────────────
// Replace this block with your actual DB/Storage context initialization
const ctx = {
  db: { upsertFile: (file: any) => { /* Your DB logic */ } },
  storage: { 
    read: async (path: string): Promise<Buffer | null> => { return Buffer.from(""); /* Your read logic */ },
    write: async (path: string, mtime: number, buf: Buffer) => { /* Your write logic */ }
  },
  config: { maxFileSizeMb: 40 }
};
// ───────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '50mb' }));

// ─── PHASE 3 & 2: Background Sync with Patch Support ───────────────────────
app.post("/api/sync/background", async (req, res) => {
  const { deviceId, files } = req.body as BackgroundSyncReq;

  if (!files || !Array.isArray(files)) {
    return res.status(400).send("Invalid payload");
  }

  for (const item of files) {
    const { file, content } = item;
    ctx.db.upsertFile(file);

    if (file.action === "active" && file.fileType === "file" && content) {
      // ✅ Handle Delta Patching from Background Sync
      if ((item as any).mode === "patch") {
        const currentBuffer = await ctx.storage.read(file.path);
        const currentText = currentBuffer ? currentBuffer.toString("utf-8") : "";

        const dmp = new diff_match_patch();
        const patches = dmp.patch_fromText(content);
        const [newText] = dmp.patch_apply(patches, currentText);

        await ctx.storage.write(file.path, file.mtime, Buffer.from(newText, "utf-8"));
      } else {
        const buf = Buffer.from(content, "base64");
        const limitBytes = ctx.config.maxFileSizeMb * 1024 * 1024;
        if (buf.length <= limitBytes) {
          await ctx.storage.write(file.path, file.mtime, buf);
        }
      }
    }
  }

  console.log(`[BackgroundSync] Processed ${files.length} files from ${deviceId}`);
  res.sendStatus(200);
});

// ─── WEBSOCKET SERVER ──────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket) => {
  console.log("[Server] Client connected");

  ws.on("message", async (data: string) => {
    try {
      // ✅ Cast to 'any' to bypass the monorepo cache bug entirely
      const rawMsg = JSON.parse(data) as any;

      if (rawMsg.type === "file_data" && (rawMsg.mode === "apply" || rawMsg.mode === "patch")) {
        
        ctx.db.upsertFile(rawMsg.file);

        if (rawMsg.file.action === "active" && rawMsg.file.fileType === "file" && rawMsg.content) {
          
          // ✅ PHASE 2: Handle Delta Patching from active WebSocket
          if (rawMsg.mode === "patch") {
            console.log(`[Delta Patch] Applying update to: ${rawMsg.file.path}`);
            
            const currentBuffer = await ctx.storage.read(rawMsg.file.path);
            const currentText = currentBuffer ? currentBuffer.toString("utf-8") : "";

            const dmp = new diff_match_patch();
            const patches = dmp.patch_fromText(rawMsg.content);
            const [newText] = dmp.patch_apply(patches, currentText);

            await ctx.storage.write(rawMsg.file.path, rawMsg.file.mtime, Buffer.from(newText, "utf-8"));

          } else {
            // Standard Full-File Push
            const buf = Buffer.from(rawMsg.content, "base64");
            const limitBytes = ctx.config.maxFileSizeMb * 1024 * 1024;
            if (buf.length <= limitBytes) {
              await ctx.storage.write(rawMsg.file.path, rawMsg.file.mtime, buf);
            }
          }
        }
      }
      
      // ... your other message handlers (auth, sync, etc.) ...

    } catch (e) {
      console.error("[Server] Message error:", e);
    }
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] IonSync Engine listening on port ${PORT}`);
}); 