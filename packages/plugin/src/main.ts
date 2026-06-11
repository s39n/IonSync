import { Plugin } from "obsidian";
import { XSync } from "./XSync.js";
import { IonSyncSettingsTab } from "./SettingsTab.js";

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
}

const DEFAULT_SETTINGS: PluginSettings = {
  host: "",
  port: 3000,
  tls: false,
  deviceId: "",
  deviceName: "",
  syncEnabled: true,
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
  exclusionList: "",
  maxFileSizeMB: 25,
  encryptionEnabled: false,
};

// ---------- Plugin ----------

export class IonSyncPlugin extends Plugin {
  settings!: PluginSettings;
  xSync!: XSync;

  override async onload(): Promise<void> {
    await this.loadSettings();

    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveSettings();
    }

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

    this.addSettingTab(new IonSyncSettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      void this.xSync.enabled(true);
    });
  }

  override onunload(): void {
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
      this.xSync.ws.isEnabled = this.settings.syncEnabled;
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
