/**
 * Manages per-path debounced timers.
 * Used to batch rapid file-modify events before sending to the server.
 */
export class XTimeouts {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Set (or reset) a debounced callback for `key`, firing after `ms` milliseconds */
  set(key: string, ms: number, callback: () => Promise<void>): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(key, setTimeout(async () => {
      this.timers.delete(key);
      try { await callback(); }
      catch (e) { console.error(`[XTimeouts] error for ${key}:`, e); }
    }, ms));
  }

  /** Cancel the timer for `key` without running the callback */
  cancel(key: string): void {
    const t = this.timers.get(key);
    if (t !== undefined) { clearTimeout(t); this.timers.delete(key); }
  }

  /** Fire all pending timers immediately (used on focus change) */
  executeAll(): void {
    for (const [key, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  /** Cancel every pending timer */
  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
