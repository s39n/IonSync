import type { FileEntry } from "@ionsync/protocol";

/**
 * IndexedDB-backed device-state store (sync redesign phase 2b).
 *
 * Holds the per-vault file metadata index (one record per path) plus a small
 * key/value `meta` store (cursor, schema version). It is a *persistence* layer
 * only — Storage keeps the authoritative in-memory map and reads it
 * synchronously; IndexStore just durably mirrors writes per-record, avoiding the
 * full-file rewrite that `metadata.json` does on every checkpoint.
 *
 * Mobile note: Obsidian's webview supports IndexedDB, but iOS WKWebView can evict
 * it under storage pressure. A wipe is not data loss — the device simply
 * re-bootstraps from the server (cursor resets to 0). Storage falls back to
 * `metadata.json` if IndexedDB is unavailable.
 */

const DB_VERSION = 1;
const FILES_STORE = "files";
const META_STORE = "meta";

export class IndexStore {
  private db: IDBDatabase | null = null;

  constructor(private dbName: string) {}

  /** True if the runtime exposes IndexedDB (always true on desktop + mobile Obsidian). */
  static isSupported(): boolean {
    return typeof indexedDB !== "undefined";
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: "path" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  private store(name: string, mode: IDBTransactionMode): IDBObjectStore {
    if (!this.db) throw new Error("IndexStore not open");
    return this.db.transaction(name, mode).objectStore(name);
  }

  /** Load every file record into a path→entry map (called once on startup). */
  getAllFiles(): Promise<Record<string, FileEntry>> {
    return new Promise((resolve, reject) => {
      const req = this.store(FILES_STORE, "readonly").getAll();
      req.onsuccess = () => {
        const out: Record<string, FileEntry> = {};
        for (const e of req.result as FileEntry[]) out[e.path] = e;
        resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  count(): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = this.store(FILES_STORE, "readonly").count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  putFile(entry: FileEntry): Promise<void> {
    return this.done(this.store(FILES_STORE, "readwrite").put(entry));
  }

  deleteFile(path: string): Promise<void> {
    return this.done(this.store(FILES_STORE, "readwrite").delete(path));
  }

  /** Bulk write in a single transaction — used for the metadata.json import. */
  putManyFiles(entries: FileEntry[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.store(FILES_STORE, "readwrite");
      for (const e of entries) store.put(e);
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => reject(store.transaction.error);
    });
  }

  getMeta(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const req = this.store(META_STORE, "readonly").get(key);
      req.onsuccess = () => resolve(req.result ? ((req.result as { value: string }).value) : null);
      req.onerror = () => reject(req.error);
    });
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.done(this.store(META_STORE, "readwrite").put({ key, value }));
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private done(req: IDBRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}
