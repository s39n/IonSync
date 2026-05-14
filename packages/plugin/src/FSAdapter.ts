import { normalizePath, TFile, type App, TFolder } from "obsidian";

export class FSAdapter {
  constructor(private app: App, private basePath: string) {}

  private norm(path: string): string {
    let full = normalizePath(this.basePath + "/" + path);
    if (full.startsWith("/")) full = full.slice(1);
    return full;
  }

  async makeFolder(path: string): Promise<void> {
    const full = this.norm(path);
    if (!full || full === ".") return;

    const parts = full.split("/");
    let cur = "";
    
    for (const part of parts) {
      if (!part) continue;
      cur = cur ? `${cur}/${part}` : part;
      
      const existing = this.app.vault.getAbstractFileByPath(cur);
      
      // FIX: ENOTDIR Collision handling. 
      if (existing instanceof TFile) {
        console.log(`[IonSync] Collision: ${cur} is a file but needs to be a folder. Removing file.`);
        try { 
          // Delete via Obsidian API so the internal cache is immediately updated
          await this.app.fileManager.trashFile(existing); 
          await new Promise(r => setTimeout(r, 50)); // Allow cache to settle
        } catch (e) {
          // Fallback to native delete
          try { await this.app.vault.adapter.remove(cur); } catch (err) {}
        }
      }

      // Ensure the folder exists natively and in cache
      const abstract = this.app.vault.getAbstractFileByPath(cur);
      if (!(abstract instanceof TFolder)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          try { await this.app.vault.adapter.mkdir(cur); } catch(err) {}
        }
      }
    }
  }

  async write(path: string, data: string, mtime?: number): Promise<void> {
    const p = this.norm(path);
    
    // Split the NORMALIZED path so Windows backslashes are safely handled
    const folderParts = p.split("/");
    if (folderParts.length > 1) {
      await this.makeFolder(folderParts.slice(0, -1).join("/"));
    }

    const opts = mtime ? { mtime } : undefined;
    
    try {
      // PRIMARY FAST PATH: Avoids I/O race conditions resulting in 0-byte blank files
      await this.app.vault.adapter.write(p, data, opts);
    } catch (writeErr: any) {
      const msg = String(writeErr?.message || writeErr || "");
      
      // Mobile/SAF Fallback Trigger
      if (!msg.includes("FILE_NOTCREATED") && !msg.includes("ENOENT") && !msg.includes("file not found")) {
         if (!(await this.app.vault.adapter.exists(p))) {
           // Proceed to fallback
         } else {
           throw writeErr;
         }
      }
      
      try {
        const file = this.app.vault.getAbstractFileByPath(p);
        if (file instanceof TFile) {
          await this.app.vault.modify(file, data);
        } else {
          await this.app.vault.create(p, data);
        }
      } catch (createErr: any) {
        const createMsg = String(createErr?.message || createErr || "");
        if (createMsg && !createMsg.includes("already exist")) throw createErr;
      }
      
      // Apply mtime as a secondary step for mobile
      if (mtime) {
        // Delay to prevent the OS file-handle race condition
        await new Promise(r => setTimeout(r, 100));
        try { await this.app.vault.adapter.write(p, data, opts); } catch {}
      }
    }
  }

  async writeBinary(path: string, data: ArrayBuffer, mtime?: number): Promise<void> {
    const p = this.norm(path);
    
    const folderParts = p.split("/");
    if (folderParts.length > 1) {
      await this.makeFolder(folderParts.slice(0, -1).join("/"));
    }

    const opts = mtime ? { mtime } : undefined;
    
    try {
      await this.app.vault.adapter.writeBinary(p, data, opts);
    } catch (writeErr: any) {
      try {
        const file = this.app.vault.getAbstractFileByPath(p);
        if (file instanceof TFile) {
          await this.app.vault.modifyBinary(file, data);
        } else {
          await this.app.vault.createBinary(p, data);
        }
      } catch (createErr: any) {
        const createMsg = String(createErr?.message || createErr || "");
        if (createMsg && !createMsg.includes("already exist")) throw createErr;
      }
      
      if (mtime) {
        await new Promise(r => setTimeout(r, 100));
        try { await this.app.vault.adapter.writeBinary(p, data, opts); } catch {}
      }
    }
  }

  async read(path: string): Promise<string | null> {
    try { return await this.app.vault.adapter.read(this.norm(path)); }
    catch { return null; }
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    try { return await this.app.vault.adapter.readBinary(this.norm(path)); }
    catch { return null; }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(this.norm(path));
  }

  async stat(path: string): Promise<{ mtime: number; ctime: number; size: number } | null> {
    try { return await this.app.vault.adapter.stat(this.norm(path)); }
    catch { return null; }
  }

  async delete(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.norm(path));
    if (file) await this.app.fileManager.trashFile(file);
  }

  async forceDelete(path: string): Promise<void> {
    await this.app.vault.adapter.remove(this.norm(path));
  }

  async iterate(
    callback: (item: { path: string; stat: { mtime: number; ctime: number; size: number } | null; isFolder: boolean }) => Promise<void>
  ): Promise<void> {
    const files = this.app.vault.getAllLoadedFiles(); 
    const baseNorm = normalizePath(this.basePath);

    for (const file of files) {
      if (baseNorm && !file.path.startsWith(baseNorm)) continue;

      let rel = file.path;
      if (baseNorm && rel.startsWith(baseNorm)) {
        rel = rel.slice(baseNorm.length).replace(/^\//, "");
      }

      const stat = await this.app.vault.adapter.stat(file.path);
      await callback({
        path: rel || "/",
        stat: stat ?? null,
        isFolder: file instanceof TFolder
      });
    }
  }
}