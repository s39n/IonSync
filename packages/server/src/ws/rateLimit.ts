/**
 * In-memory per-IP rate limiter for incoming WebSocket connections.
 *
 * Two protections:
 *  1. Connection flooding / DoS — caps how many connection attempts a single IP
 *     may make within a sliding window. Over the cap, the IP is blocked for
 *     `blockMs` (a fixed backoff), during which new connections are refused
 *     before the auth challenge is even sent.
 *  2. Password brute-force — each failed auth is recorded; once an IP exceeds
 *     `maxAuthFailures` within the window it is blocked too. Because every guess
 *     needs its own connection, the connection cap already slows brute-force,
 *     but counting failures lets us block a guessing client far sooner than a
 *     client that connects-and-behaves.
 *
 * This is intentionally simple (single process, no shared store). It is a
 * mitigation, not a substitute for a real WAF / reverse-proxy rate limit in
 * front of the server. State is pruned lazily and via `sweep()`.
 */

export interface RateLimitOptions {
  /** Sliding window length in ms. */
  windowMs: number;
  /** Max connection attempts per IP per window before blocking. */
  maxConnections: number;
  /** Max failed auths per IP per window before blocking. */
  maxAuthFailures: number;
  /** How long an IP stays blocked once it trips a limit, in ms. */
  blockMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60_000,
  // Generous enough for legitimate reconnect storms (mobile flapping, multiple
  // devices behind one NAT) but well below what a brute-force/DoS run needs.
  maxConnections: 60,
  maxAuthFailures: 10,
  blockMs: 5 * 60_000,
};

interface IpState {
  windowStart: number;
  connections: number;
  authFailures: number;
  blockedUntil: number;
}

export class ConnectionRateLimiter {
  private readonly opts: RateLimitOptions;
  private readonly ips = new Map<string, IpState>();

  constructor(opts: RateLimitOptions = DEFAULT_RATE_LIMIT) {
    this.opts = opts;
  }

  /** Roll the window forward if it has elapsed, resetting the counters. */
  private current(ip: string, now: number): IpState {
    let st = this.ips.get(ip);
    if (!st) {
      st = { windowStart: now, connections: 0, authFailures: 0, blockedUntil: 0 };
      this.ips.set(ip, st);
    } else if (now - st.windowStart >= this.opts.windowMs) {
      st.windowStart = now;
      st.connections = 0;
      st.authFailures = 0;
    }
    return st;
  }

  /**
   * Record a connection attempt and decide whether to allow it.
   * Returns false when the IP is currently blocked or has exceeded the cap.
   */
  allowConnection(ip: string, now: number = Date.now()): boolean {
    const st = this.current(ip, now);
    if (now < st.blockedUntil) return false;
    st.connections += 1;
    if (st.connections > this.opts.maxConnections) {
      st.blockedUntil = now + this.opts.blockMs;
      return false;
    }
    return true;
  }

  /** Record a failed authentication; blocks the IP once over the threshold. */
  recordAuthFailure(ip: string, now: number = Date.now()): void {
    const st = this.current(ip, now);
    st.authFailures += 1;
    if (st.authFailures > this.opts.maxAuthFailures) {
      st.blockedUntil = now + this.opts.blockMs;
    }
  }

  /** Whether an IP is presently blocked. */
  isBlocked(ip: string, now: number = Date.now()): boolean {
    const st = this.ips.get(ip);
    return !!st && now < st.blockedUntil;
  }

  /** Drop state for IPs that are idle and not blocked. Call periodically. */
  sweep(now: number = Date.now()): void {
    for (const [ip, st] of this.ips) {
      const windowExpired = now - st.windowStart >= this.opts.windowMs;
      const unblocked = now >= st.blockedUntil;
      if (windowExpired && unblocked) this.ips.delete(ip);
    }
  }
}
