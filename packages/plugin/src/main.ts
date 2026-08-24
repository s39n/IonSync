import { Plugin, Platform, TFile } from "obsidian";
import { XSync } from "./XSync.js";
import { IonSyncSettingsTab } from "./SettingsTab.js";

// Stamped by the esbuild post-build plugin — lets you confirm in the dev console
// (Ctrl+Shift+I) which build is actually running after a rebuild/redeploy.
declare const __IONSYNC_BUILD__: string;
const BUILD = typeof __IONSYNC_BUILD__ !== "undefined" ? __IONSYNC_BUILD__ : "dev";

// ---------- Settings ----------

export interface PluginSettings {
  host: string;
  port: number;
  tls: boolean;
  deviceId: string;
  deviceName: string;
  syncEnabled: boolean;
  autoSync: boolean;
  delayedSync: number;
  notifications: number;
  debug: boolean;
  syncHiddenFiles: boolean;
  syncTrash: boolean;
  syncImages: boolean;
  syncAudio: boolean;
  syncVideos: boolean;
  syncPDFs: boolean;
  syncOtherTypes: boolean;
  syncThemesAndSnippets: boolean;
  syncMainSettings: boolean;
  syncAppearanceSettings: boolean;
  syncHotkeys: boolean;
  syncActiveCorePlugins: boolean;
  syncCorePluginSettings: boolean;
  syncActiveCommunityPlugins: boolean;
  syncInstalledCommunityPlugins: boolean;
  /**
   * Per-device master switch: when true, this device keeps ALL Obsidian config
   * (.obsidian/**) local — nothing under the config folder is uploaded or
   * applied, so appearance, hotkeys, plugins, layout, etc. stay device-specific.
   * Notes still sync normally. Overrides the individual config toggles above.
   */
  keepConfigLocal: boolean;
  exclusionList: string;
  /**
   * Files strictly larger than this value (in MB) are silently skipped during
   * computeTree and real-time events.  Keeps the plugin and server from loading
   * gigantic binaries into memory.  Must stay below maxPayload ÷ 1.34 on the
   * server (the base64 expansion factor).  Default 25 MB → ~33 MB on the wire,
   * safely under the server's 50 MB WebSocket message cap.
   */
  maxFileSizeMB: number;

  // ── End-to-End Encryption ─────────────────────────────────────────────────
  /**
   * When true, all file content is encrypted client-side with AES-256-GCM
   * before being sent to the server.  The server stores and relays ciphertext
   * only and never possesses the decryption key.
   *
   * Every device that shares the same vault must use the same encryptionPassword.
   * Files that were already on the server before E2EE was enabled remain
   * in plaintext until they are next modified and re-uploaded.
   */
  encryptionEnabled: boolean;

  // ── Cursor sync state (phase 2) ───────────────────────────────────────────
  /**
   * Highest server sequence number this device has applied. Sent as `since` in
   * `sync_cursor`; the server replays only changes past it. 0 = full bootstrap.
   */
  lastSyncedSeq: number;
  /**
   * The server endpoint (`host:port:tls`) the cursor belongs to. If it changes,
   * the cursor is meaningless and we bootstrap from 0.
   */
  lastSyncedEndpoint: string;
  /**
   * True once the device has completed at least one full bootstrap (a sync that
   * ended in sync_done). Used instead of "has any metadata" to detect first
   * sync, so an *interrupted* bootstrap that wrote some files is still treated
   * as first-sync (keeping the delete-queue safety guard) until it finishes.
   */
  bootstrapComplete: boolean;
  /**
   * True while a bootstrap is underway but has NOT yet finished (set when a
   * first-sync starts, cleared on sync_done). Persisted so that if the app is
   * closed or the sync stalls mid-bootstrap, the next load knows the metadata on
   * disk is PARTIAL and must not be mistaken for a completed sync. Without this,
   * "has metadata → assume complete" silently leaves a device permanently
   * missing files while reporting "fully synced".
   */
  bootstrapInProgress: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
  host: "",
  port: 3000,
  tls: false,
  deviceId: "",
  deviceName: "",
  // New devices start PAUSED. A fresh install should not connect and begin
  // pulling/pushing until the user has entered the server AND (for an E2EE vault)
  // the encryption password — otherwise a device with the wrong/no key would
  // download undecryptable files. The user enables sync deliberately in settings.
  syncEnabled: false,
  autoSync: true,
  delayedSync: 0,
  notifications: 1,
  debug: false,
  syncHiddenFiles: false,
  syncTrash: false,
  syncImages: true,
  syncAudio: true,
  syncVideos: false,
  syncPDFs: true,
  syncOtherTypes: false,
  syncThemesAndSnippets: false,
  syncMainSettings: false,
  syncAppearanceSettings: false,
  syncHotkeys: false,
  syncActiveCorePlugins: false,
  syncCorePluginSettings: false,
  syncActiveCommunityPlugins: false,
  syncInstalledCommunityPlugins: false,
  keepConfigLocal: false,
  exclusionList: "",
  maxFileSizeMB: 25,
  encryptionEnabled: false,
  lastSyncedSeq: 0,
  lastSyncedEndpoint: "",
  bootstrapComplete: false,
  bootstrapInProgress: false,
};

/**
 * A distinct, human-readable default device name for a brand-new install, so
 * every device is self-labelled and unique out of the box — two browsers both
 * running Obsidian Web no longer both show up as just "Obsidian Web". The
 * 4-char suffix comes from the device's own UUID (guaranteed unique); the
 * prefix reflects the runtime. The user can still rename it in settings.
 */
function defaultDeviceName(deviceId: string): string {
  const suffix = deviceId.replace(/-/g, "").slice(0, 4) || "0000";
  const kind = Platform.isMobile
    ? "Obsidian Mobile"
    : Platform.isDesktopApp
      ? "Obsidian Desktop"
      : "Obsidian Web";
  return `${kind} ${suffix}`;
}

// ---------- Plugin ----------

export class IonSyncPlugin extends Plugin {
  // Obsidian 1.13+ typings declare `Plugin.settings?: unknown` — narrow it here.
  override settings!: PluginSettings;
  xSync!: XSync;
  /** Safety timer for the deferred (post-indexing) startup. */
  private _startTimer: number | null = null;

  override async onload(): Promise<void> {
    console.log(`[IonSync] plugin loaded — build ${BUILD}`);
    await this.loadSettings();

    let identitySet = false;
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      identitySet = true;
    }
    // Auto-assign a distinct default name on first run so every device is
    // identifiable and unique in the dashboard (and the added-by/edited-by
    // attribution) without the user having to name each one by hand.
    if (!this.settings.deviceName) {
      this.settings.deviceName = defaultDeviceName(this.settings.deviceId);
      identitySet = true;
    }
    if (identitySet) await this.saveSettings();

    this.xSync = new XSync(this);

    const statusBarItem = this.addStatusBarItem();
    this.xSync.xNotify.makeStatusBarItem(statusBarItem);

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => { void this.xSync.sync(); },
    });

    this.addCommand({
      id: "toggle-auto-sync",
      name: "Toggle auto-sync",
      callback: async () => {
        this.settings.autoSync = !this.settings.autoSync;
        await this.saveSettings();
      },
    });

    this.addCommand({
      id: "verify-against-server",
      name: "Verify vault against server",
      callback: () => { void this.xSync.verifyNow(); },
    });

    // Open the server-backed version history for a file. Dynamic require keeps
    // the modal bundle out of the module-load cycle (same pattern as XNotify).
    const openVersionHistory = (path: string) => {
      const { VersionHistoryModal } = require("./modals/index.js") as typeof import("./modals/index.js");
      new VersionHistoryModal(this, path).open();
    };

    // Command palette (keyboard-assignable) — version history for the active file.
    this.addCommand({
      id: "file-version-history",
      name: "Show version history for current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) openVersionHistory(file.path);
        return true;
      },
    });

    // Command palette — review/resolve sync conflicts from inside Obsidian.
    this.addCommand({
      id: "show-conflicts",
      name: "Show sync conflicts",
      callback: () => {
        const { ConflictsModal } = require("./modals/index.js") as typeof import("./modals/index.js");
        new ConflictsModal(this).open();
      },
    });

    // Right-click a file in the explorer / tab header → Version history.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        menu.addItem((item) =>
          item.setTitle("Version history").setIcon("history").setSection("info")
            .onClick(() => openVersionHistory(file.path))
        );
      })
    );

    // Right-click inside an open note → Version history for that note.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return;
        menu.addItem((item) =>
          item.setTitle("Version history").setIcon("history").setSection("info")
            .onClick(() => openVersionHistory(file.path))
        );
      })
    );

    this.addSettingTab(new IonSyncSettingsTab(this.app, this));

    // Defer the first connect/sync until BOTH the layout is ready AND the vault's
    // metadata indexing has settled — so the plugin doesn't compete with the
    // indexer (which crawls slow devices) and the first reconcile sees a complete
    // file list. The "resolved" listener is registered now (before layout ready)
    // so a warm-start event firing early isn't missed. On a slow device indexing
    // can take much longer than a fixed delay, so the timer is only a last resort.
    let layoutReady = false;
    let indexed = false;
    let started = false;
    const maybeStart = () => {
      if (started || !layoutReady || !indexed) return;
      started = true;
      if (this._startTimer !== null) { window.clearTimeout(this._startTimer); this._startTimer = null; }
      void this.xSync.enabled(true);
    };
    this.registerEvent(this.app.metadataCache.on("resolved", () => { indexed = true; maybeStart(); }));
    this.app.workspace.onLayoutReady(() => { layoutReady = true; maybeStart(); });
    // Last resort: start anyway if "resolved" never arrives on this setup.
    this._startTimer = window.setTimeout(() => { indexed = true; layoutReady = true; maybeStart(); }, 45_000);
  }

  override onunload(): void {
    if (this._startTimer !== null) { window.clearTimeout(this._startTimer); this._startTimer = null; }
    this.xSync?.destroy();
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PluginSettings & { password?: string; encryptionPassword?: string }> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});

    // One-time migration: move plaintext secrets from data.json into the keychain.
    if (saved?.password) {
      this.app.secretStorage.setSecret("ionsync-password", saved.password);
      delete (this.settings as any).password;
      await this.saveData(this.settings);
    }
    if (saved?.encryptionPassword) {
      this.app.secretStorage.setSecret("ionsync-encryption-password", saved.encryptionPassword);
      delete (this.settings as any).encryptionPassword;
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.xSync) {
      // Connect/disconnect immediately so Pause/Resume actually takes effect.
      this.xSync.ws.setEnabled(this.settings.syncEnabled);
    }
  }

  // ── Keychain helpers ──────────────────────────────────────────────────────

  getPassword(): string {
    return this.app.secretStorage.getSecret("ionsync-password") ?? "";
  }

  setPassword(value: string): void {
    this.app.secretStorage.setSecret("ionsync-password", value);
  }

  getEncryptionPassword(): string {
    return this.app.secretStorage.getSecret("ionsync-encryption-password") ?? "";
  }

  setEncryptionPassword(value: string): void {
    this.app.secretStorage.setSecret("ionsync-encryption-password", value);
  }

  log(...args: unknown[]): void {
    if (this.settings.debug) {
      console.log("[IonSync]", ...args);
    }
  }

  getSVGIcon(): string {
    // Atom — nucleus dot + three orbital ellipses at 0°, 60°, 120°
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle><ellipse cx="12" cy="12" rx="10" ry="3.5"></ellipse><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(60 12 12)"></ellipse><ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(120 12 12)"></ellipse></svg>`;
  }
}

export default IonSyncPlugin;
