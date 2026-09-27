import type {
  ServerMsg,
  ClientMsg,
  VersionCheckResponseMsg,
} from "@ionsync/protocol";
import { encodeFrame, decodeFrame, BINARY_FRAMES_CAP, BACKGROUND_SYNC_PATH } from "@ionsync/protocol";
import type { FileDataUploadMsg } from "@ionsync/protocol";
import { Platform } from "obsidian";
import type { IonSyncPlugin, PluginSettings } from "./main.js";

// ---------- Types ----------

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

  /** While non-null, full-file uploads passing through send() are also
   *  recorded here so they can be re-delivered by beacon (see XSync). */
  private captured: FileDataUploadMsg[] | null = null;
  /** path → time of the last upload sent for it. Used to find edits whose bytes
   *  may still have been sitting in the socket buffer when the app backgrounded. */
  private recentUploads = new Map<string, number>();

  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private reconnectDelay = 1_000;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private reconnectTimer: number | null = null;
  private mobileVisibilityListener?: () => void;

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
    if (Platform.isMobile && typeof document !== "undefined") {
      this.mobileVisibilityListener = () => {
        if (!document.hidden) this.scheduleReconnect(0);
      };
      document.addEventListener("visibilitychange", this.mobileVisibilityListener);
    }
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

  send(msg: ClientMsg): void {
    if (msg.type === "file_data" && (msg.mode === "apply" || msg.mode === "patch")) {
      this.recentUploads.set(msg.file.path, Date.now());
      if (this.recentUploads.size > 500) {
        const cutoff = Date.now() - 60_000;
        for (const [p, t] of this.recentUploads) if (t < cutoff) this.recentUploads.delete(p);
      }
      // Captured before the readyState check: a socket that just dropped is
      // exactly the case the beacon exists to rescue. Only full uploads are
      // beaconable (a patch needs the WS path's server-side stitch).
      if (msg.mode === "apply") this.captured?.push(msg);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.log("Sending:", msg.type);
    // encodeFrame emits a binary frame for a content-bearing upload when the
    // server advertised "binary_frames"; otherwise a JSON string (base64ing any
    // raw bytes back into `content`). Falls back automatically against an old
    // server (serverCaps empty).
    this.ws.send(encodeFrame(msg, this.serverCaps.includes(BINARY_FRAMES_CAP)));
  }

  /** Start recording full-file uploads sent through send(). */
  beginCapture(): void { this.captured = []; }

  /** Stop recording and return what was captured. */
  endCapture(): FileDataUploadMsg[] {
    const out = this.captured ?? [];
    this.captured = null;
    return out;
  }

  /** Paths uploaded within the last `withinMs` — candidates whose bytes may not
   *  have left the device if the OS froze the app right after. */
  recentUploadPaths(withinMs: number): string[] {
    const cutoff = Date.now() - withinMs;
    const out: string[] = [];
    for (const [p, t] of this.recentUploads) if (t >= cutoff) out.push(p);
    return out;
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
        // Advertise binary_frames so the server can push file content as binary
        // frames to us. The server gates on this per-peer; an old server ignores
        // the field and we fall back to base64 (serverCaps stays empty).
        this.send({ type: "version_check", version: VERSION, build: BUILD_STR, caps: [BINARY_FRAMES_CAP] });
        break;
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
