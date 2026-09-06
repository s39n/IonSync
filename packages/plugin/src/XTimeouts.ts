/**
 * Manages per-path debounced timers.
 * Used to batch rapid file-modify events before sending to the server.
 */
export class XTimeouts {
  // Stores the callback alongside the timer handle. executeAll() needs the
  // callback itself to actually run it early — a map of bare timer handles
  // (the previous shape) can only ever be used to CANCEL, never to fire, which
  // silently turned every "flush pending edits" call site (focus change,
  // backgrounding) into a callback-dropping no-op: the debounced upload for
  // whatever the user was mid-typing when they switched notes or backgrounded
  // the app was cancelled and never sent, leaving the local file diverged from
  // the last-synced metadata until some later incoming push exposed it as a
  // spurious conflict.
  private timers = new Map<string, { timer: number; callback: () => Promise<void> }>();

  /** Set (or reset) a debounced callback for `key`, firing after `ms` milliseconds */
  set(key: string, ms: number, callback: () => Promise<void>): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) window.clearTimeout(existing.timer);
    const timer = window.setTimeout(async () => {
      this.timers.delete(key);
      try { await callback(); }
      catch (e) { console.error(`[XTimeouts] error for ${key}:`, e); }
    }, ms);
    this.timers.set(key, { timer, callback });
  }

  /** Cancel the timer for `key` without running the callback */
  cancel(key: string): void {
    const entry = this.timers.get(key);
    if (entry !== undefined) { window.clearTimeout(entry.timer); this.timers.delete(key); }
  }

  /**
   * Fire all pending timers immediately, awaiting every callback (used on
   * focus change and before backgrounding on mobile). Callers that need the
   * flush to actually complete before taking a further action (e.g.
   * disconnecting the socket) must await this.
   */
  async executeAll(): Promise<void> {
    const pending = Array.from(this.timers.values());
    this.timers.clear();
    for (const { timer } of pending) window.clearTimeout(timer);
    await Promise.all(pending.map(async ({ callback }) => {
      try { await callback(); }
      catch (e) { console.error("[XTimeouts] executeAll callback error:", e); }
    }));
  }

  /** Cancel every pending timer */
  clear(): void {
    for (const { timer } of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }
}
