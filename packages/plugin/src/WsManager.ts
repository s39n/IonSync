import type {
  ServerMsg,
  ClientMsg,
  VersionCheckResponseMsg,
} from "@ionsync/protocol";
import { Platform } from "obsidian";
import type { IonSyncPlugin, PluginSettings } from "./main.js";

// ---------- Types ----------

export interface UpdateInfo {
  files: { name: string; content: string }[];
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

  private ws: WebSocket | null = null;
  private listeners: Listener[] = [];
  private reconnectDelay = 1_000;
  private readonly MAX_RECONNECT_DELAY = 30_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private mobileVisibilityListener?: () => void;

  private get settings(): PluginSettings { return this.plugin.settings; }

  constructor(private plugin: IonSyncPlugin) {
    // On mobile, disconnect when the app goes to the background and reconnect
    // when it comes back to the foreground. This avoids drained battery from a
    // stale socket and prevents the OS from killing the socket underneath us.
    //
    // On desktop we intentionally skip this — minimising/alt-tabbing fires
    // visibilitychange too, which would cause a reconnect (and two notifications)
    // every time the user switches windows. The server's ping/pong keepalive and
    // the existing onclose handler already manage genuine connection drops there.
    if (Platform.isMobile && typeof document !== "undefined") {
      this.mobileVisibilityListener = () => {
        if (document.hidden) this.disconnect();
        else this.scheduleReconnect(0);
      };
      document.addEventListener("visibilitychange", this.mobileVisibilityListener);
    }
  }

  private log(...args: unknown[]): void {
    if (this.settings.debug) {
      console.log("[WsManager]", ...args);
    }
  }

  on(listener: Listener): void { this.listeners.push(listener); }
  off(listener: Listener): void { this.listeners = this.listeners.filter((l) => l !== listener); }

  private emit(event: WsManagerEvent): void {
    for (const l of this.listeners) {
      try { l(event); } catch (e) { console.error("[WsManager] listener error:", e); }
    }
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.log("Sending:", msg.type);
    this.ws.send(JSON.stringify(msg));
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
    const host = this.settings.host.replace(/\/+$/, ""); // strip any trailing slashes
    const { port } = this.settings;
    const scheme = this.settings.tls ? "wss" : "ws";
    const defaultPort = this.settings.tls ? 443 : 80;
    const url = port && port !== defaultPort
      ? `${scheme}://${host}:${port}`
      : `${scheme}://${host}`;
    this.log("Opening WebSocket to:", url);

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.error("[WsManager] WebSocket constructor failed:", e);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.log("WebSocket opened");
      this.reconnectDelay = 1_000;
    };

    this.ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: ServerMsg;
      try { msg = JSON.parse(ev.data) as ServerMsg; }
      catch (e) { console.error("[WsManager] bad JSON:", e); return; }
      this.log("Received:", msg.type);
      this._handleMessage(msg).catch((e) => console.error("[WsManager] message handler error:", e));
    };

    this.ws.onerror = (ev) => { console.error("[WsManager] error:", ev); };

    this.ws.onclose = () => {
      this.log("WebSocket closed");
      this.ws = null;
      if (this.isConnected) {
        this.isConnected = false;
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
        this.send({ type: "version_check", version: VERSION, build: BUILD_STR });
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
      this.isConnected = true;
      this.emit({ type: "connected" });
      return;
    }
    // Build a { name, content }[] list from the Record<string, string> map
    const files: { name: string; content: string }[] = Object.entries(msg.files ?? {}).map(
      ([name, content]) => ({ name, content })
    );
    this.emit({ type: "update_available", update: { files } });
  }

  private scheduleReconnect(delay?: number): void {
    if (!this.isEnabled) return;
    this._cancelReconnect();
    const ms = delay ?? this.reconnectDelay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isEnabled) this._openSocket();
    }, ms);
    this.reconnectDelay = Math.min(this.MAX_RECONNECT_DELAY, this.reconnectDelay * 2);
  }

  private _cancelReconnect(): void {
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}
