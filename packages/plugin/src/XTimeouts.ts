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

  // Callbacks whose timer already fired but which are still running (an upload
  // mid stat/read/hash/encrypt). Without tracking these, a debounce that fired
  // a moment before the app was backgrounded was invisible to both keys() and
  // executeAll(): the flush didn't wait for it, the socket closed under it, and
  // its edit was stranded with nothing recording that it was unconfirmed.
  private inFlight = new Map<string, Promise<void>>();

  /** Set (or reset) a debounced callback for `key`, firing after `ms` milliseconds */
  set(key: string, ms: number, callback: () => Promise<void>): void {
    const existing = this.timers.get(key);
    if (existing !== undefined) window.clearTimeout(existing.timer);
    const timer = window.setTimeout(() => {
      this.timers.delete(key);
      void this._run(key, callback);
    }, ms);
    this.timers.set(key, { timer, callback });
  }

  private async _run(key: string, callback: () => Promise<void>): Promise<void> {
    const p = (async () => {
      try { await callback(); }
      catch (e) { window.console.error(`[XTimeouts] error for ${key}:`, e); }
    })();
    this.inFlight.set(key, p);
    try { await p; }
    finally { if (this.inFlight.get(key) === p) this.inFlight.delete(key); }
  }

  /** Cancel the timer for `key` without running the callback */
  cancel(key: string): void {
    const entry = this.timers.get(key);
    if (entry !== undefined) { window.clearTimeout(entry.timer); this.timers.delete(key); }
  }

  /**
   * Fire all pending timers immediately, and wait for those plus any callback
   * already running (used on focus change and before backgrounding on mobile).
   * Callers that need the flush to actually complete before taking a further
   * action (e.g. disconnecting the socket) must await this.
   */
  async executeAll(): Promise<void> {
    const pending = Array.from(this.timers.entries());
    this.timers.clear();
    for (const [, { timer }] of pending) window.clearTimeout(timer);
    const running = Array.from(this.inFlight.values());
    await Promise.all([
      ...pending.map(([key, { callback }]) => this._run(key, callback)),
      ...running,
    ]);
  }

  /** Keys (file paths) with a pending or still-running callback. */
  keys(): string[] {
    return Array.from(new Set([...this.timers.keys(), ...this.inFlight.keys()]));
  }

  /** Cancel every pending timer (running callbacks finish on their own). */
  clear(): void {
    for (const { timer } of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }
}
