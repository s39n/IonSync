import { PluginSettingTab, Setting, App } from "obsidian";
import type { IonSyncPlugin } from "./main.js";

export class IonSyncSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: IonSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "IonSync" });

    // ── Connection ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Server host")
      .setDesc("Hostname or IP of your sync server")
      .addText((t) =>
        t.setPlaceholder("192.168.1.100")
          .setValue(this.plugin.settings.host)
          .onChange(async (v) => { this.plugin.settings.host = v.trim().replace(/\/+$/, ""); await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Server port")
      .setDesc("Port your sync server listens on (leave blank to use the default: 80 for ws, 443 for wss)")
      .addText((t) => {
        t.setPlaceholder("default")
          .setValue(this.plugin.settings.port ? String(this.plugin.settings.port) : "");
        t.inputEl.addEventListener("blur", async () => {
          const v = t.inputEl.value.trim();
          const n = parseInt(v, 10);
          this.plugin.settings.port = (!v || isNaN(n) || n <= 0) ? 0 : n;
          t.inputEl.value = this.plugin.settings.port ? String(this.plugin.settings.port) : "";
          await this.plugin.saveSettings();
        });
        return t;
      });

    new Setting(containerEl)
      .setName("Password")
      .setDesc("Shared secret configured on the server")
      .addText((t) =>
        t.setPlaceholder("your-password")
          .setValue(this.plugin.settings.password)
          .onChange(async (v) => { this.plugin.settings.password = v; await this.plugin.saveSettings(); })
          .inputEl.setAttribute("type", "password")
      );

    new Setting(containerEl)
      .setName("Use TLS (wss://)")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.tls ?? false)
          .onChange(async (v) => { this.plugin.settings.tls = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Human-readable label shown in the server dashboard")
      .addText((t) =>
        t.setPlaceholder("My Laptop")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (v) => { this.plugin.settings.deviceName = v; await this.plugin.saveSettings(); })
      );

    // ── Sync behaviour ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Enable sync")
      .setDesc("Master switch — disabling pauses all sync activity")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncEnabled)
          .onChange(async (v) => { this.plugin.settings.syncEnabled = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically sync on connection and vault events")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSync)
          .onChange(async (v) => { this.plugin.settings.autoSync = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Delayed sync (seconds)")
      .setDesc("Wait this many seconds after a modify event before uploading (0 = instant)")
      .addSlider((s) =>
        s.setLimits(0, 60, 1)
          .setValue(this.plugin.settings.delayedSync)
          .setDynamicTooltip()
          .onChange(async (v) => { this.plugin.settings.delayedSync = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Notifications")
      .setDesc("0 = none, 1 = errors only, 2 = all")
      .addSlider((s) =>
        s.setLimits(0, 2, 1)
          .setValue(this.plugin.settings.notifications)
          .setDynamicTooltip()
          .onChange(async (v) => { this.plugin.settings.notifications = v; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debug)
          .onChange(async (v) => { this.plugin.settings.debug = v; await this.plugin.saveSettings(); })
      );

    // ── What to sync ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "What to sync" });

    const toggleSetting = (name: string, desc: string, key: keyof typeof this.plugin.settings) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings[key] as boolean)
            .onChange(async (v) => {
              (this.plugin.settings as any)[key] = v;
              await this.plugin.saveSettings();
            })
        );
    };

    toggleSetting("Hidden files", "Files/folders starting with '.'", "syncHiddenFiles");
    toggleSetting("Trash (.trash)", "Obsidian trash folder", "syncTrash");
    toggleSetting("Images", "png, jpg, gif, etc.", "syncImages");
    toggleSetting("Audio", "mp3, wav, ogg, etc.", "syncAudio");
    toggleSetting("Video", "mp4, mkv, avi, etc.", "syncVideos");
    toggleSetting("PDFs", "PDF files", "syncPDFs");
    toggleSetting("Themes & snippets", ".obsidian/themes/ and .obsidian/snippets/", "syncThemesAndSnippets");
    toggleSetting("Main settings", ".obsidian/app.json", "syncMainSettings");
    toggleSetting("Appearance settings", ".obsidian/appearance.json", "syncAppearanceSettings");
    toggleSetting("Hotkeys", ".obsidian/hotkeys.json", "syncHotkeys");
    toggleSetting("Active core plugins", "core-plugins.json", "syncActiveCorePlugins");
    toggleSetting("Core plugin settings", ".obsidian/plugins/ (built-in)", "syncCorePluginSettings");
    toggleSetting("Active community plugins", "community-plugins.json", "syncActiveCommunityPlugins");
    toggleSetting("Installed community plugins", ".obsidian/plugins/", "syncInstalledCommunityPlugins");

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc(
        "Files larger than this are skipped — they will not be hashed, uploaded, or downloaded. " +
        "Keep this below ~35 MB to stay within the server's 50 MB per-message WebSocket limit. " +
        "Existing oversized files already on the server are unaffected."
      )
      .addSlider((s) =>
        s.setLimits(1, 100, 1)
          .setValue(this.plugin.settings.maxFileSizeMB ?? 25)
          .setDynamicTooltip()
          .onChange(async (v) => { this.plugin.settings.maxFileSizeMB = v; await this.plugin.saveSettings(); })
      );

    // ── End-to-End Encryption ───────────────────────────────────────────────
    containerEl.createEl("h3", { text: "End-to-End Encryption" });

    new Setting(containerEl)
      .setName("Enable E2EE")
      .setDesc(
        "Encrypt all file content on this device using AES-256-GCM before uploading. " +
        "The server stores and relays ciphertext only and never has access to your key. " +
        "Every device sharing this vault must use the same Encryption Password. " +
        "Files already on the server remain in plaintext until they are next modified."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.encryptionEnabled)
          .onChange(async (v) => {
            const wasDisabled = !this.plugin.settings.encryptionEnabled;
            this.plugin.settings.encryptionEnabled = v;
            await this.plugin.saveSettings();
            this.display();
            // When E2EE is turned on, re-upload every file so the server ends
            // up with a fully-encrypted vault rather than a mixed one.
            if (v && wasDisabled && this.plugin.xSync) {
              void this.plugin.xSync.triggerReEncrypt();
            }
          })
      );

    if (this.plugin.settings.encryptionEnabled) {
      new Setting(containerEl)
        .setName("Encryption password")
        .setDesc(
          "Passphrase used to derive the AES-256-GCM key via PBKDF2. " +
          "Must be identical on every device that syncs this vault. " +
          "Changing this makes existing encrypted server files unreadable until re-uploaded."
        )
        .addText((t) => {
          t.setPlaceholder("strong-passphrase")
            .setValue(this.plugin.settings.encryptionPassword)
            .onChange(async (v) => {
              this.plugin.settings.encryptionPassword = v;
              await this.plugin.saveSettings();
            });
          t.inputEl.setAttribute("type", "password");
          t.inputEl.style.width = "260px";
          return t;
        });

      const warn = containerEl.createEl("div");
      warn.style.cssText =
        "border: 1px solid var(--color-orange); border-radius: 6px; " +
        "padding: 10px 14px; margin: 4px 0 12px; font-size: 12px; " +
        "color: var(--color-orange); " +
        "background: color-mix(in srgb, var(--color-orange) 10%, transparent);";
      warn.setText(
        "There is no password recovery. If you forget this passphrase " +
        "you will permanently lose access to all encrypted files stored on the server. " +
        "Store it in a password manager before enabling."
      );

      new Setting(containerEl)
        .setName("Re-encrypt all files")
        .setDesc(
          "Force every file to be re-uploaded as encrypted. Use this if some files " +
          "were synced before E2EE was enabled and are still stored in plaintext on the server."
        )
        .addButton((btn) => {
          btn.setButtonText("Re-encrypt all files now")
            .setCta()
            .onClick(async () => {
              if (!this.plugin.xSync) return;
              btn.setButtonText("Re-encrypting…");
              btn.setDisabled(true);
              await this.plugin.xSync.triggerReEncrypt();
              btn.setButtonText("Done — syncing now");
              setTimeout(() => {
                btn.setButtonText("Re-encrypt all files now");
                btn.setDisabled(false);
              }, 4000);
            });
        });
    }

    // ── Exclusion list ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Exclusion list" });
    containerEl.createEl("p", { text: "One glob pattern per line. Lines starting with # are comments." });

    new Setting(containerEl)
      .addTextArea((ta) =>
        ta.setPlaceholder("*.log\nsecrets/**")
          .setValue(this.plugin.settings.exclusionList)
          .onChange(async (v) => { this.plugin.settings.exclusionList = v; await this.plugin.saveSettings(); })
      )
      .settingEl.style.flexDirection = "column";
  }
}
