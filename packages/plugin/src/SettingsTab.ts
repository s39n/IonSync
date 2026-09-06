import { PluginSettingTab, Setting, App } from "obsidian";
import type { IonSyncPlugin } from "./main.js";

export class IonSyncSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: IonSyncPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    ;

    // ── Connection ──────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Connection").setHeading();

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
      .setDesc("Shared secret configured on the server (stored in the system keychain)")
      .addText((t) => {
        t.setPlaceholder("your-password")
          .setValue(this.plugin.getPassword())
          .onChange((v) => { this.plugin.setPassword(v); });
        t.inputEl.setAttribute("type", "password");
        return t;
      });

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
    new Setting(containerEl).setName("Sync").setHeading();

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
      .setDesc("Wait this many seconds after a modify event before uploading (0 = fastest, ~0.75s)")
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
    new Setting(containerEl).setName("What to sync").setHeading();

    const toggleSetting = (name: string, desc: string, key: keyof typeof this.plugin.settings) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings[key] as boolean)
            .onChange(async (v) => {
              (this.plugin.settings as unknown as Record<string, boolean>)[key] = v;
              await this.plugin.saveSettings();
              this.plugin.xSync?.scheduleFullReconcile();
            })
        );
    };

    new Setting(containerEl)
      .setName("Keep settings local to this device")
      .setDesc(
        "Per-device profile: don't sync any Obsidian settings (.obsidian config) on this device — " +
        "appearance, hotkeys, plugins, layout, etc. stay local. Notes still sync. " +
        "Overrides the individual config toggles below."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.keepConfigLocal)
          .onChange(async (v) => { this.plugin.settings.keepConfigLocal = v; await this.plugin.saveSettings(); this.plugin.xSync?.scheduleFullReconcile(); })
      );

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
    toggleSetting("Core plugin settings", ".obsidian/*.json (e.g. daily-notes.json, templates.json)", "syncCorePluginSettings");
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
          .onChange(async (v) => { this.plugin.settings.maxFileSizeMB = v; await this.plugin.saveSettings(); this.plugin.xSync?.scheduleFullReconcile(); })
      );

    // ── End-to-End Encryption ───────────────────────────────────────────────
    new Setting(containerEl).setName("End-to-End Encryption").setHeading();

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
            .setValue(this.plugin.getEncryptionPassword())
            .onChange((v) => { this.plugin.setEncryptionPassword(v); });
          t.inputEl.setAttribute("type", "password");
          t.inputEl.setAttribute("autocomplete", "new-password");
          t.inputEl.setAttribute("autocorrect", "off");
          t.inputEl.setAttribute("autocapitalize", "none");
          t.inputEl.setAttribute("spellcheck", "false");
          t.inputEl.style.width = "260px";
          return t;
        });

      const warn = containerEl.createDiv();
      warn.style.cssText =
        "border: 1px solid var(--color-orange); border-radius: 6px; " +
        "padding: 10px 14px; margin: 4px 0 12px; font-size: 12px; " +
        "color: var(--color-orange); " +
        "background: var(--background-modifier-error);";
      warn.setText(
        "There is no password recovery. If you forget this passphrase " +
        "you will permanently lose access to all encrypted files stored on the server. " +
        "Store it in a password manager before enabling."
      );

      const hasSalt = !!this.plugin.settings.e2eeInstallSalt;
      new Setting(containerEl)
        .setName("Per-install encryption salt (v3)")
        .setDesc(
          "On by default. Derives the key with a random salt unique to this server instead " +
          "of the shared built-in salt — stronger against precomputation and cross-install " +
          "key reuse. Each device switches to it automatically once it has received the salt " +
          "from the server (connect once); until then it keeps writing the older v2 format, " +
          "which every device can still read. Use “Re-encrypt all files” below to migrate " +
          "existing content to v3. Turn this off only if you must keep writing v2 for a " +
          "device that can't be updated." +
          (hasSalt ? "" : " (Waiting for the salt — connect to the server once to receive it.)")
        )
        .addToggle((t) =>
          t.setValue(this.plugin.settings.e2eeWriteV3)
            .setDisabled(!hasSalt && !this.plugin.settings.e2eeWriteV3)
            .onChange(async (v) => {
              await this.plugin.enableE2eeV3(v);
              this.display();
            })
        );

      new Setting(containerEl)
        .setName("Re-encrypt all files")
        .setDesc(
          "Force every file to be re-uploaded as encrypted. Use this if some files " +
          "were synced before E2EE was enabled and are still stored in plaintext on the server." +
          " Also migrates existing files to the per-install salt (v3) once it is enabled above."
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
              window.setTimeout(() => {
                btn.setButtonText("Re-encrypt all files now");
                btn.setDisabled(false);
              }, 4000);
            });
        });
    }

    // ── Exclusion list ──────────────────────────────────────────────────────
    new Setting(containerEl).setName("Exclusion list").setHeading();
    containerEl.createEl("p", { text: "One glob pattern per line. Lines starting with # are comments." });

    new Setting(containerEl)
      .addTextArea((ta) =>
        ta.setPlaceholder("*.log\nsecrets/**")
          .setValue(this.plugin.settings.exclusionList)
          .onChange(async (v) => { this.plugin.settings.exclusionList = v; await this.plugin.saveSettings(); this.plugin.xSync?.scheduleFullReconcile(); })
      )
      .settingEl.style.flexDirection = "column";

    // ── Support ─────────────────────────────────────────────────────────────
    const supportEl = containerEl.createDiv();
    supportEl.style.cssText =
      "margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--background-modifier-border); text-align: center;";
    const coffeeLink = supportEl.createEl("a", {
      text: "☕ Buy me a coffee",
      href: "https://buymeacoffee.com/seanseanric",
    });
    coffeeLink.style.cssText =
      "color: var(--text-accent); font-size: 13px; text-decoration: none;";
    coffeeLink.setAttribute("target", "_blank");
    coffeeLink.setAttribute("rel", "noopener");
    supportEl.createEl("p", { text: "IonSync is free and open source. Tips are appreciated!" })
      .style.cssText = "margin-top: 6px; font-size: 12px; color: var(--text-muted);";
  }
}
