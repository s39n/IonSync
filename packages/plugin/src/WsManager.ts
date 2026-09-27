import type {
  ServerMsg,
  ClientMsg,
  VersionCheckResponseMsg,
} from "@ionsync/protocol";
import { encodeFrame, decodeFrame, BINARY_FRAMES_CAP, BACKGROUND_SYNC_PATH, APP_PING_CAP, PIPELINED_AUTH_CAP } from "@ionsync/protocol";
import type { FileDataUploadMsg } from "@ionsync/protocol";
import { Platform } from "obsidian";
import type { IonSyncPlugin, PluginSettings } from "./main.js";

// ---------- Types ----------

/** An upload recently handed to the socket (see WsManager.recentUploads). */
export interface RecentUpload {
  t: number;
  sha1: string;
  baseSha1?: string;
  originBaseSha1?: string;
}

/** Sends of the same path this close together are one burst of edits. */
const BURST_MS = 10_000;

/**
 * Mobile: how long the socket is kept after the app is backgrounded (XSync owns
 * the timer). A quick trip to another app and back then needs no reconnect.
 * Matches the server's 30s ping sweep, past which a suspended socket is likely
 * dead anyway.
 */
export const HIDE_GRACE_MS = 30_000;

/** How long a returning app waits for a `pong` before reconnecting instead. */
const RESUME_PROBE_MS = 3_000;

export interface UpdateInfo {
  files: { name: string; content: string }[];
  /** base64 ed25519 signature of main.js; verified before applying (fail closed). */
  signature?: string;
  /** base64 ed25519 signature over all allowlisted update files. */
  filesSignature?: string;
}

export type WsManagerEvent =
  | { type: "connected" }
  | { type: "disconnected" }
  /** Mobile: the app came back and the socket kept from before is still alive. */
  | { type: "resumed" }
  | { type: "update_available"; update: UpdateInfo }
  | { type: "incompatible" }
  | { type: "message"; msg: ServerMsg };

type Listener = (event: WsManagerEvent) => void;

// Stamped by esbuild post-build plugin
declare const __IONSYNC_VERSION__: string;
declare const __IONSYNC_BUILD__: string;

const VERSION = typeof __IONSYNC_VERSION__ !== "undefined" ? __IONSYNC_VERSION__ : "0.0.0";
const BUILD_STR = typeof __IONSYNC_BUILD__ !== "undefined" ? __IONSYNC_BUILD__ : "0";

// ---------- WsManager ----------

/**
 * Manages the WebSocket lifecycle for the v2 IonSync protocol.
 *
 * Connection flow:
 *  1. Open WebSocket to ws[s]://host:port
 *  2. Receive { type: "challenge", nonce }
 *  3. Send { type: "auth", deviceId, token: sha256(nonce[0:16] + password + nonce[16:]) }
 *  4. Receive { type: "auth_ok" | "auth_error" }
 *  5. Send { type: "version_check", version, build }
 *  6. Receive { type: "version_check_response", ... }
 *  7. Emit "connected" → XSync starts syncing
 */
export class WsManager {
  isConnected = false;
  isEnabled = false;
  /** Capability tokens advertised by the connected server (e.g. "file_rename").
   *  Empty until version_check_response arrives, and reset on disconnect so a
   *  reconnect to an older server can't inherit a stale capability. */
  serverCaps: string[] = [];
  /** Device-bound token for the mobile background flush, from `auth_ok`.
   *  Kept across a disconnect (the beacon fires as the socket closes); rotated
   *  by the server on every connect. Null against servers that predate it. */
  bgToken: string | null = null;
  /** Mobile hide grace period: refuse state-changing sends (see send()). Set by
   *  XSync once the hide flush is done; cleared on return and on any socket
   *  change. */
  holdOutbound = false;
  /** Something was refused by the hold since the last takeRefusedDuringHold(). */
  private refusedDuringHold = false;

  /** Whether any send was refused during the hold; resets the flag. */
  takeRefusedDuringHold(): boolean {
    const r = this.refusedDuringHold;
    this.refusedDuringHold = false;
    return r;
  }

  /** Active capture buffers: full-file uploads passing through send() are also
   *  recorded into each, so they can be re-delivered by beacon (see XSync).
   *  One buffer per flush, so overlapping flushes (a quick hide→show→hide)
   *  can't clobber each other's captures. */
  private captures = new Set<FileDataUploadMsg[]>();
  /** path → the last upload sent for it: when, its sha1, and the base it was
   *  built on (the TRUE pre-send base — metadata is overwritten right after
   *  sending). Used to find, and correctly re-send, edits whose bytes may still
   *  have been in the socket buffer when the OS froze the app.
   *  `originBaseSha1` is the base the current burst of sends started from:
   *  if every send in the burst was lost, the server never saw `baseSha1`, and
   *  it judges a replay against the origin instead. */
  private recentUploads = new Map<string, RecentUpload>();

  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private reconnectDelay = 1_000;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private reconnectTimer: number | null = null;
  private mobileVisibilityListener?: () => void;
  /** When the app was last backgrounded (mobile), or 0 while visible. */
  private hiddenAt = 0;
  /** Server caps seen on the last successful handshake, per endpoint URL. Kept
   *  across disconnects (unlike serverCaps) so a reconnect can pipeline. */
  private knownCaps = new Map<string, string[]>();
  /** version_check already sent on the current socket (pipelined with auth). */
  private versionCheckSent = false;
  /** version_check_response received on the current socket. */
  private gotVersionResponse = false;
  private pingSeq = 0;
  private pongWaiters = new Map<number, (alive: boolean) => void>();

  private get settings(): PluginSettings { return this.plugin.settings; }

  constructor(private plugin: IonSyncPlugin) {
    // On mobile, reconnect promptly when the app comes back to the foreground
    // (rather than waiting out the exponential backoff from whatever drop
    // happened while backgrounded). This avoids drained battery from a stale
    // socket and prevents the OS from killing it underneath us.
    //
    // The background→disconnect side deliberately does NOT live here. It used
    // to: this listener called disconnect() directly on `document.hidden`, in
    // parallel with XSync's own visibilitychange listener whose job is to flush
    // any debounced pending upload before the socket closes. Both listeners fire
    // on the same event, and there is no ordering guarantee that makes the flush
    // finish before this one's disconnect() runs — so the pending edit's
    // ws.send() could easily lose the race against the socket closing,
    // discarding it. XSync.load() now owns the entire hidden-side sequence
    // (await flush, then disconnect) so the two can never race. See XSync.ts.
    //
    // On desktop we intentionally skip the reconnect-on-visible behavior too —
    // minimising/alt-tabbing fires visibilitychange too, which would cause a
    // reconnect (and two notifications) every time the user switches windows.
    // The server's ping/pong keepalive and the existing onclose handler already
    // manage genuine connection drops there.
    //
    // A socket may now survive a short trip to another app (XSync keeps it for
    // HIDE_GRACE_MS). On return we don't trust it blindly — a suspended app's
    // socket can be dead without having noticed — but probe it: alive → carry on
    // with no reconnect at all; dead, or away longer than the grace → reconnect
    // immediately, exactly as before.
    if (Platform.isMobile && typeof document !== "undefined") {
      this.mobileVisibilityListener = () => {
        if (document.hidden) { this.hiddenAt = Date.now(); return; }
        const awayMs = this.hiddenAt > 0 ? Date.now() - this.hiddenAt : 0;
        this.hiddenAt = 0;
        const open = this.isConnected && this.ws?.readyState === WebSocket.OPEN;
        if (open && awayMs <= HIDE_GRACE_MS) { void this._checkResumedSocket(); return; }
        if (open) {
          // Away too long: the socket is most likely dead; don't wait on a probe.
          this.log(`Away ${Math.round(awayMs / 1000)}s — reconnecting fresh`);
          this.disconnect();
        }
        this.reconnectDelay = 1_000;
        this.scheduleReconnect(0);
      };
      document.addEventListener("visibilitychange", this.mobileVisibilityListener);
    }
  }

  /**
   * Liveness probe for a socket that outlived a background period. Resolves
   * true on a `pong` within `timeoutMs`, false on timeout or a closed socket.
   * Against a server without APP_PING_CAP it can't probe and trusts an open
   * socket (such a server never gets a grace period anyway — see XSync).
   */
  probe(timeoutMs: number): Promise<boolean> {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    if (!this.serverCaps.includes(APP_PING_CAP)) return Promise.resolve(true);
    const n = ++this.pingSeq;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => { this.pongWaiters.delete(n); resolve(false); }, timeoutMs);
      this.pongWaiters.set(n, (alive) => { window.clearTimeout(timer); resolve(alive); });
      if (!this.send({ type: "ping", n })) {
        this.pongWaiters.delete(n);
        window.clearTimeout(timer);
        resolve(false);
      }
    });
  }

  private async _checkResumedSocket(): Promise<void> {
    const probed = this.ws;
    const alive = await this.probe(RESUME_PROBE_MS);
    // The socket changed while we waited (it closed and a reconnect already
    // replaced it): never tear down the new one. If it closed and nothing has
    // replaced it yet, reconnect now rather than after the backoff.
    if (this.ws !== probed) {
      if (!this.ws) this.scheduleReconnect(0);
      return;
    }
    // Hidden again while the probe was out: that hide re-armed the hold and
    // the grace timer. Keep holding; the next return probes afresh.
    if (typeof document !== "undefined" && document.hidden) return;
    if (alive) {
      this.log("Resumed on the existing socket");
      // Only now is it safe to write through this socket again.
      this.holdOutbound = false;
      this.emit({ type: "resumed" });
      return;
    }
    this.log("Socket didn't answer after resume — reconnecting");
    this.disconnect();
    this.reconnectDelay = 1_000;
    this._openSocket();
  }

  /** Fail any outstanding probes (the socket they were sent on is gone). */
  private _failProbes(): void {
    const waiters = [...this.pongWaiters.values()];
    this.pongWaiters.clear();
    for (const w of waiters) w(false);
  }

  private log(...args: unknown[]): void {
    // window.console (member access) is used because Obsidian's lint config
    // forbids the bare console global.
    if (this.settings.debug) {
      window.console.log("[WsManager]", ...args);
    }
  }

  on(listener: Listener): void { this.listeners.push(listener); }
  off(listener: Listener): void { this.listeners = this.listeners.filter((l) => l !== listener); }

  private emit(event: WsManagerEvent): void {
    for (const l of this.listeners) {
      try { l(event); } catch (e) { console.error("[WsManager] listener error:", e); }
    }
  }

  /**
   * Enable or disable syncing and act on it immediately. Previously Pause only
   * flipped `isEnabled`, which left an already-open socket connected and syncing
   * — so pausing did nothing visible. Now it connects/disconnects right away.
   */
  setEnabled(enabled: boolean): void {
    if (this.isEnabled === enabled) return;
    this.isEnabled = enabled;
    if (enabled) this.connect();
    else this.disconnect();
  }

  connect(): void {
    if (!this.isEnabled) return;
    if (!this.plugin.getPassword()) {
      console.warn("[WsManager] No password configured");
      return;
    }
    this.log("Connecting...");
    this._openSocket();
  }

  /** Bytes queued in the WebSocket's outgoing buffer but not yet sent. */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /**
   * Send a message. Returns true only if it was handed to an OPEN socket —
   * callers that record "this is now synced" must not do so on false.
   */
  send(msg: ClientMsg): boolean {
    // Hide grace period: the socket is kept open but nothing that changes
    // server state may leave through it — the hide flush already recorded
    // everything it sent, and a send made now could sit in the socket buffer
    // when the OS suspends the app, then die with it, unrecorded. Refusing it
    // makes the caller treat it like a closed socket (queue it / record it as
    // unsent for the reconnect replay). Reads (sync_cursor, history, …) and the
    // liveness ping still go through.
    if (this.holdOutbound && WsManager._changesServerState(msg)) {
      this.refusedDuringHold = true;
      return false;
    }
    const isUpload = msg.type === "file_data" && (msg.mode === "apply" || msg.mode === "patch");
    // Captured before the readyState check: a socket that just dropped is
    // exactly the case the beacon exists to rescue. Only full, first-time
    // uploads are beaconable (a patch needs the WS path's server-side stitch;
    // a resend's conflict semantics need the WS path's resend handling).
    if (isUpload && msg.mode === "apply" && !msg.resend) for (const buf of this.captures) buf.push(msg);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.log("Sending:", msg.type);
    // encodeFrame emits a binary frame for a content-bearing upload when the
    // server advertised "binary_frames"; otherwise a JSON string (base64ing any
    // raw bytes back into `content`). Falls back automatically against an old
    // server (serverCaps empty).
    this.ws.send(encodeFrame(msg, this.serverCaps.includes(BINARY_FRAMES_CAP)));
    if (isUpload) {
      // Only uploads that actually went out: these may or may not have left
      // the device before the OS froze the app. Resends are recorded too — a
      // replay that is itself frozen mid-flight must be replayable again.
      const now = Date.now();
      const prev = this.recentUploads.get(msg.file.path);
      const origin = prev && now - prev.t <= BURST_MS
        ? (prev.originBaseSha1 ?? prev.baseSha1)
        : (msg.originBaseSha1 ?? msg.baseSha1);
      this.recentUploads.set(msg.file.path, {
        t: now,
        sha1: msg.file.sha1,
        ...(msg.baseSha1 ? { baseSha1: msg.baseSha1 } : {}),
        ...(origin && origin !== msg.baseSha1 ? { originBaseSha1: origin } : {}),
      });
      if (this.recentUploads.size > 500) {
        const cutoff = Date.now() - 60_000;
        for (const [p, r] of this.recentUploads) if (r.t < cutoff) this.recentUploads.delete(p);
      }
    }
    return true;
  }

  /** Uploads, deletes, conflict records, renames: messages that write server state. */
  private static _changesServerState(msg: ClientMsg): boolean {
    if (msg.type === "file_data") return msg.mode !== "send";
    return msg.type === "file_rename" || msg.type === "file_event";
  }

  /** Start recording full-file uploads sent through send(). Returns this
   *  flush's own buffer; pass it back to endCapture(). */
  beginCapture(): FileDataUploadMsg[] {
    const buf: FileDataUploadMsg[] = [];
    this.captures.add(buf);
    return buf;
  }

  /** Stop recording into `buf` and return it. */
  endCapture(buf: FileDataUploadMsg[]): FileDataUploadMsg[] {
    this.captures.delete(buf);
    return buf;
  }

  /** Uploads sent within the last `withinMs` — candidates whose bytes may not
   *  have left the device if the OS froze the app right after — with the sha
   *  and true base each was sent with. */
  recentUploadDetails(withinMs: number): (RecentUpload & { path: string })[] {
    const cutoff = Date.now() - withinMs;
    const out: (RecentUpload & { path: string })[] = [];
    for (const [path, r] of this.recentUploads) {
      if (r.t >= cutoff) out.push({ path, ...r });
    }
    return out;
  }

  /** The last upload handed to the socket for `path`, if any. */
  recentUploadFor(path: string): RecentUpload | undefined {
    return this.recentUploads.get(path);
  }

  /** Base URL of the server for a scheme family, from the same settings the
   *  socket uses (so the beacon always targets the server we're syncing with). */
  private _endpoint(family: "ws" | "http"): string {
    const host = this.settings.host.replace(/\/+$/, ""); // strip any trailing slashes
    const { port } = this.settings;
    const scheme = family === "ws"
      ? (this.settings.tls ? "wss" : "ws")
      : (this.settings.tls ? "https" : "http");
    const defaultPort = this.settings.tls ? 443 : 80;
    return port && port !== defaultPort ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
  }

  /** Where the mobile background flush is POSTed. */
  get backgroundSyncUrl(): string {
    return this._endpoint("http") + BACKGROUND_SYNC_PATH;
  }

  disconnect(): void {
    this.log("Disconnecting");
    this._cancelReconnect();
    this._failProbes();
    this.holdOutbound = false;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.isConnected) {
      this.isConnected = false;
      this.serverCaps = [];
      this.emit({ type: "disconnected" });
    }
  }

  destroy(): void {
    this.disconnect();
    if (this.mobileVisibilityListener) {
      document.removeEventListener("visibilitychange", this.mobileVisibilityListener);
    }
    this.listeners = [];
  }

  private _openSocket(): void {
    if (!this.isEnabled) return;
    // Guard against opening a second socket on top of one that's already
    // connecting/open. This became reachable once the background disconnect
    // moved to XSync (see the comment in the constructor): a quick
    // background→foreground flicker can fire the foreground reconnect while
    // XSync's flush-then-disconnect is still awaiting the flush, so the old
    // socket may still be alive when this runs.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.log("Skipping reconnect — a socket is already open/connecting");
      return;
    }
    const url = this._endpoint("ws");
    this.log("Opening WebSocket to:", url);
    this.versionCheckSent = false;
    this.gotVersionResponse = false;
    this.holdOutbound = false; // a fresh socket starts clean
    this.refusedDuringHold = false;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error("[WsManager] WebSocket constructor failed:", e);
      this.scheduleReconnect();
      return;
    }

    // Binary frames (file_push content) arrive as ArrayBuffer, not Blob, so we
    // can decode them synchronously without an async FileReader step.
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.log("WebSocket opened");
      this.reconnectDelay = 1_000;
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      let msg: ServerMsg;
      try {
        // String → JSON control message / legacy base64 content.
        // ArrayBuffer → binary envelope; decodeFrame attaches msg.contentBytes.
        const data = typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer);
        msg = decodeFrame(data) as ServerMsg;
      } catch (e) { console.error("[WsManager] bad frame:", e); return; }
      this.log("Received:", msg.type);
      this._handleMessage(msg).catch((e) => console.error("[WsManager] message handler error:", e));
    };

    this.ws.onerror = (ev) => { console.error("[WsManager] error:", ev); };

    this.ws.onclose = () => {
      this.log("WebSocket closed");
      this.ws = null;
      this._failProbes();
      this.holdOutbound = false;
      // A pipelined handshake that died before the version check came back:
      // don't keep pipelining on the strength of an old answer — the next
      // connect goes sequential and re-learns the caps.
      if (this.versionCheckSent && !this.gotVersionResponse) this.knownCaps.delete(url);
      if (this.isConnected) {
        this.isConnected = false;
        this.serverCaps = [];
        this.emit({ type: "disconnected" });
      }
      this.scheduleReconnect();
    };
  }

  private async _handleMessage(msg: ServerMsg): Promise<void> {
    switch (msg.type) {
      case "challenge":
        await this._handleChallenge(msg.nonce);
        break;
      case "auth_ok":
        // Persist the per-install E2EE salt if the server sent one (SECURITY.md
        // #7). Fire-and-forget: it only enables v3 reads/writes and never blocks
        // the handshake. Older servers omit it and we stay on the global salt.
        if (msg.e2eeSalt) void this.plugin.applyE2eeSalt(msg.e2eeSalt);
        // Background-flush token (servers that predate it omit the field).
        this.bgToken = msg.bgToken ?? null;
        // Already sent right behind `auth` when this server is known to handle
        // that (see _handleChallenge); otherwise send it now.
        if (!this.versionCheckSent) this._sendVersionCheck();
        break;
      case "pong": {
        const waiter = this.pongWaiters.get(msg.n);
        this.pongWaiters.delete(msg.n);
        waiter?.(true);
        break;
      }
      case "auth_error":
        console.error("[WsManager] Authentication failed");
        this.disconnect();
        break;
      case "version_check_response":
        this._handleVersionCheck(msg);
        break;
      default:
        this.emit({ type: "message", msg });
    }
  }

  private async _handleChallenge(nonce: string): Promise<void> {
    const token = await this._computeToken(nonce, this.plugin.getPassword());
    this.send({
      type: "auth",
      deviceId: this.settings.deviceId,
      ...(this.settings.deviceName ? { deviceName: this.settings.deviceName } : {}),
      token,
    });
    // Pipeline the version check behind auth when this server told us (on an
    // earlier connection this session) that it handles that — one round trip
    // fewer on every reconnect. First contact stays strictly sequential.
    if ((this.knownCaps.get(this._endpoint("ws")) ?? []).includes(PIPELINED_AUTH_CAP)) {
      this._sendVersionCheck();
    }
  }

  private _sendVersionCheck(): void {
    this.versionCheckSent = true;
    // Advertise binary_frames so the server can push file content as binary
    // frames to us. The server gates on this per-peer; an old server ignores
    // the field and we fall back to base64 (serverCaps stays empty).
    this.send({ type: "version_check", version: VERSION, build: BUILD_STR, caps: [BINARY_FRAMES_CAP] });
  }

  private async _computeToken(nonce: string, password: string): Promise<string> {
    const input = nonce.slice(0, 16) + password + nonce.slice(16);
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
    return hex;
  }

  private _handleVersionCheck(msg: VersionCheckResponseMsg): void {
    this.gotVersionResponse = true;
    this.knownCaps.set(this._endpoint("ws"), msg.caps ?? []);
    if (!msg.needsUpdate) {
      this.serverCaps = msg.caps ?? [];
      this.isConnected = true;
      this.emit({ type: "connected" });
      return;
    }
    // Build a { name, content }[] list from the Record<string, string> map
    const files: { name: string; content: string }[] = Object.entries(msg.files ?? {}).map(
      ([name, content]) => ({ name, content })
    );
    this.emit({ type: "update_available", update: {
      files,
      ...(msg.signature ? { signature: msg.signature } : {}),
      ...(msg.filesSignature ? { filesSignature: msg.filesSignature } : {}),
    } });
  }

  private scheduleReconnect(delay?: number): void {
    if (!this.isEnabled) return;
    this._cancelReconnect();
    const ms = delay ?? this.reconnectDelay;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isEnabled) this._openSocket();
    }, ms);
    this.reconnectDelay = Math.min(this.MAX_RECONNECT_DELAY, this.reconnectDelay * 2);
  }

  private _cancelReconnect(): void {
    if (this.reconnectTimer !== null) { window.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}
