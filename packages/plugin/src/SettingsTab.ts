import { PluginSettingTab, Setting, App } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type { IonSyncPlugin } from "./main.js";

/**
 * A single settings row: its search metadata plus a builder that configures
 * the Obsidian `Setting`. The builder holds the actual control logic and is
 * shared verbatim between the two render paths (see below), so they can never
 * drift.
 */
interface Row {
  name: string;
  desc?: string;
  /** Excluded from settings search when false. */
  searchable?: boolean;
  build: (s: Setting) => unknown;
}

/** A titled section of rows; `visible` gates the whole section (heading + rows). */
interface Section {
  heading?: string;
  visible?: () => boolean;
  rows: Row[];
}

export class IonSyncSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: IonSyncPlugin) {
    super(app, plugin);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Two render paths, one source of truth.
  //
  // Obsidian 1.13+ renders the tab declaratively from getSettingDefinitions()
  // — this is what makes every setting appear in the settings search. Obsidian
  // ignores display() once getSettingDefinitions() returns a non-empty array;
  // display() is kept ONLY as the pre-1.13 fallback (manifest minAppVersion is
  // 1.11.4). Both paths iterate the same _sections() and build each row with
  // the same Row.build, so the imperative and declarative views are identical.
  // ───────────────────────────────────────────────────────────────────────

  /** Pre-1.13 fallback renderer. Unused on 1.13+ (getSettingDefinitions wins). */
  override display(): void {
    this._renderFallback();
  }

  private _renderFallback(): void {
    const { containerEl } = this;
    containerEl.empty();
    // On <1.13 there is no declarative update(); re-render in place instead.
    const sections = this._sections(() => this._renderFallback());
    for (const sec of sections) {
      if (sec.visible && !sec.visible()) continue;
      if (sec.heading) new Setting(containerEl).setName(sec.heading).setHeading();
      for (const row of sec.rows) this._applyRow(new Setting(containerEl), row);
    }
  }

  /** 1.13+ declarative definitions — same rows, made searchable. */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    // Re-render to re-evaluate the E2EE section's `visible` predicate after the
    // master toggle changes. update() is Obsidian 1.13+; this closure only ever
    // runs on 1.13+ (Obsidian only calls getSettingDefinitions there), so it is
    // always present — the guarded call keeps it off the 1.11.4 API surface
    // rather than assuming an API the manifest's minAppVersion doesn't promise.
    const reRender = () => { (this as { update?: () => void }).update?.(); };
    const sections = this._sections(reRender);
    return sections.map((sec): SettingDefinitionItem => ({
      type: "group",
      ...(sec.heading ? { heading: sec.heading } : {}),
      ...(sec.visible ? { visible: sec.visible } : {}),
      items: sec.rows.map((row) => ({
        name: row.name || " ",
        ...(row.desc ? { desc: row.desc } : {}),
        ...(row.searchable === false ? { searchable: false } : {}),
        render: (s: Setting) => this._applyRow(s, row),
      })),
    }));
  }

  /** Apply a Row to a Setting: name/desc for both paths, then the control. */
  private _applyRow(s: Setting, row: Row): void {
    if (row.name) s.setName(row.name);
    if (row.desc) s.setDesc(row.desc);
    row.build(s);
  }

  // ───────────────────────────────────────────────────────────────────────
  // The settings themselves. `reRender` is how the E2EE toggles refresh the
  // conditional section: display() re-renders in place; the declarative path
  // calls update().
  // ───────────────────────────────────────────────────────────────────────

  private _sections(reRender: () => void): Section[] {
    const p = this.plugin;
    const configDir = this.app.vault.configDir;

    // Toggle bound to a boolean setting key that also re-reconciles the vault.
    const syncToggle = (name: string, desc: string, key: keyof typeof p.settings): Row => ({
      name,
      desc,
      build: (s) =>
        s.addToggle((t) =>
          t.setValue(p.settings[key] as boolean).onChange(async (v) => {
            (p.settings as unknown as Record<string, boolean>)[key] = v;
            await p.saveSettings();
            p.xSync?.scheduleFullReconcile();
          })
        ),
    });

    return [
      // ── Connection ──────────────────────────────────────────────────────
      {
        heading: "Connection",
        rows: [
          {
            name: "Server host",
            desc: "Hostname or IP of your sync server",
            build: (s) =>
              s.addText((t) =>
                t.setPlaceholder("192.168.1.100")
                  .setValue(p.settings.host)
                  .onChange(async (v) => { p.settings.host = v.trim().replace(/\/+$/, ""); await p.saveSettings(); })
              ),
          },
          {
            name: "Server port",
            desc: "Port your sync server listens on (leave blank to use the default: 80 for ws, 443 for wss)",
            build: (s) =>
              s.addText((t) => {
                t.setPlaceholder("default")
                  .setValue(p.settings.port ? String(p.settings.port) : "");
                t.inputEl.addEventListener("blur", () => {
                  const v = t.inputEl.value.trim();
                  const n = parseInt(v, 10);
                  p.settings.port = (!v || isNaN(n) || n <= 0) ? 0 : n;
                  t.inputEl.value = p.settings.port ? String(p.settings.port) : "";
                  void p.saveSettings();
                });
                return t;
              }),
          },
          {
            name: "Password",
            desc: "Shared secret configured on the server (stored in the system keychain)",
            build: (s) =>
              s.addText((t) => {
                t.setPlaceholder("your-password")
                  .setValue(p.getPassword())
                  .onChange((v) => { p.setPassword(v); });
                t.inputEl.setAttribute("type", "password");
                return t;
              }),
          },
          {
            name: "Use TLS (wss://)",
            build: (s) =>
              s.addToggle((t) =>
                t.setValue(p.settings.tls ?? false)
                  .onChange(async (v) => { p.settings.tls = v; await p.saveSettings(); })
              ),
          },
          {
            name: "Device name",
            desc: "Human-readable label shown in the server dashboard",
            build: (s) =>
              s.addText((t) =>
                t.setPlaceholder("My Laptop")
                  .setValue(p.settings.deviceName)
                  .onChange(async (v) => { p.settings.deviceName = v; await p.saveSettings(); })
              ),
          },
        ],
      },

      // ── Sync ────────────────────────────────────────────────────────────
      {
        heading: "Sync",
        rows: [
          {
            name: "Enable sync",
            desc: "Master switch — disabling pauses all sync activity",
            build: (s) =>
              s.addToggle((t) =>
                t.setValue(p.settings.syncEnabled)
                  .onChange(async (v) => { p.settings.syncEnabled = v; await p.saveSettings(); })
              ),
          },
          {
            name: "Auto-sync",
            desc: "Automatically sync on connection and vault events",
            build: (s) =>
              s.addToggle((t) =>
                t.setValue(p.settings.autoSync)
                  .onChange(async (v) => { p.settings.autoSync = v; await p.saveSettings(); })
              ),
          },
          {
            name: "Delayed sync (seconds)",
            desc: "Wait this many seconds after a modify event before uploading (0 = fastest, ~0.75s)",
            build: (s) =>
              s.addSlider((sl) =>
                sl.setLimits(0, 60, 1)
                  .setValue(p.settings.delayedSync)
                  .onChange(async (v) => { p.settings.delayedSync = v; await p.saveSettings(); })
              ),
          },
          {
            name: "Notifications",
            desc: "0 = none, 1 = errors only, 2 = all",
            build: (s) =>
              s.addSlider((sl) =>
                sl.setLimits(0, 2, 1)
                  .setValue(p.settings.notifications)
                  .onChange(async (v) => { p.settings.notifications = v; await p.saveSettings(); })
              ),
          },
          {
            name: "Debug logging",
            build: (s) =>
              s.addToggle((t) =>
                t.setValue(p.settings.debug)
                  .onChange(async (v) => { p.settings.debug = v; await p.saveSettings(); })
              ),
          },
        ],
      },

      // ── What to sync ────────────────────────────────────────────────────
      {
        heading: "What to sync",
        rows: [
          {
            name: "Keep settings local to this device",
            desc:
              `Per-device profile: don't sync any Obsidian settings (${configDir} config) on this device — ` +
              "appearance, hotkeys, plugins, layout, etc. stay local. Notes still sync. " +
              "Overrides the individual config toggles below.",
            build: (s) =>
              s.addToggle((t) =>
                t.setValue(p.settings.keepConfigLocal)
                  .onChange(async (v) => { p.settings.keepConfigLocal = v; await p.saveSettings(); p.xSync?.scheduleFullReconcile(); })
              ),
          },
          syncToggle("Hidden files", "Files/folders starting with '.'", "syncHiddenFiles"),
          syncToggle("Trash (.trash)", "Obsidian trash folder", "syncTrash"),
          syncToggle("Images", "png, jpg, gif, etc.", "syncImages"),
          syncToggle("Audio", "mp3, wav, ogg, etc.", "syncAudio"),
          syncToggle("Video", "mp4, mkv, avi, etc.", "syncVideos"),
          syncToggle("PDFs", "PDF files", "syncPDFs"),
          syncToggle("Themes & snippets", `${configDir}/themes/ and ${configDir}/snippets/`, "syncThemesAndSnippets"),
          syncToggle("Main settings", `${configDir}/app.json`, "syncMainSettings"),
          syncToggle("Appearance settings", `${configDir}/appearance.json`, "syncAppearanceSettings"),
          syncToggle("Hotkeys", `${configDir}/hotkeys.json`, "syncHotkeys"),
          syncToggle("Active core plugins", "core-plugins.json", "syncActiveCorePlugins"),
          syncToggle("Core plugin settings", `${configDir}/*.json (e.g. daily-notes.json, templates.json)`, "syncCorePluginSettings"),
          syncToggle("Active community plugins", "community-plugins.json", "syncActiveCommunityPlugins"),
          syncToggle("Installed community plugins", `${configDir}/plugins/`, "syncInstalledCommunityPlugins"),
          {
            name: "Max file size (MB)",
            desc:
              "Files larger than this are skipped — they will not be hashed, uploaded, or downloaded. " +
              "Keep this below ~35 MB to stay within the server's 50 MB per-message WebSocket limit. " +
              "Existing oversized files already on the server are unaffected.",
            build: (s) =>
              s.addSlider((sl) =>
                sl.setLimits(1, 100, 1)
                  .setValue(p.settings.maxFileSizeMB ?? 25)
                  .onChange(async (v) => { p.settings.maxFileSizeMB = v; await p.saveSettings(); p.xSync?.scheduleFullReconcile(); })
              ),
          },
        ],
      },

      // ── End-to-End Encryption ───────────────────────────────────────────
      {
        heading: "End-to-End Encryption",
        rows: [
          {
            name: "Enable E2EE",
            desc:
              "Encrypt all file content on this device using AES-256-GCM before uploading. " +
              "The server stores and relays ciphertext only and never has access to your key. " +
              "Every device sharing this vault must use the same Encryption Password. " +
              "Files already on the server remain in plaintext until they are next modified.",
            build: (s) =>
              s.addToggle((t) =>
                t.setValue(p.settings.encryptionEnabled)
                  .onChange(async (v) => {
                    const wasDisabled = !p.settings.encryptionEnabled;
                    p.settings.encryptionEnabled = v;
                    await p.saveSettings();
                    reRender();
                    // When E2EE is turned on, re-upload every file so the server
                    // ends up with a fully-encrypted vault rather than a mixed one.
                    if (v && wasDisabled && p.xSync) {
                      void p.xSync.triggerReEncrypt();
                    }
                  })
              ),
          },
        ],
      },

      // ── E2EE details (only when E2EE is enabled) ────────────────────────
      {
        visible: () => p.settings.encryptionEnabled,
        rows: [
          {
            name: "Encryption password",
            desc:
              "Passphrase used to derive the AES-256-GCM key via PBKDF2. " +
              "Must be identical on every device that syncs this vault. " +
              "Changing this makes existing encrypted server files unreadable until re-uploaded.",
            build: (s) =>
              s.addText((t) => {
                t.setPlaceholder("strong-passphrase")
                  .setValue(p.getEncryptionPassword())
                  .onChange((v) => { p.setEncryptionPassword(v); });
                t.inputEl.setAttribute("type", "password");
                t.inputEl.setAttribute("autocomplete", "new-password");
                t.inputEl.setAttribute("autocorrect", "off");
                t.inputEl.setAttribute("autocapitalize", "none");
                t.inputEl.setAttribute("spellcheck", "false");
                t.inputEl.addClass("ion-pw-input");
                return t;
              }),
          },
          {
            name: "Encryption recovery warning",
            searchable: false,
            build: (s) => {
              s.setDesc(
                "There is no password recovery. If you forget this passphrase " +
                "you will permanently lose access to all encrypted files stored on the server. " +
                "Store it in a password manager before enabling."
              );
              s.settingEl.addClass("ion-e2ee-warn");
            },
          },
          {
            name: "Per-install encryption salt (v3)",
            desc:
              "On by default. Derives the key with a random salt unique to this server instead " +
              "of the shared built-in salt — stronger against precomputation and cross-install " +
              "key reuse. Each device switches to it automatically once it has received the salt " +
              "from the server (connect once); until then it keeps writing the older v2 format, " +
              "which every device can still read. Use “Re-encrypt all files” below to migrate " +
              "existing content to v3. Turn this off only if you must keep writing v2 for a " +
              "device that can't be updated.",
            build: (s) => {
              const hasSalt = !!p.settings.e2eeInstallSalt;
              if (!hasSalt) {
                s.setDesc(
                  (s.descEl.textContent ?? "") +
                  " (Waiting for the salt — connect to the server once to receive it.)"
                );
              }
              s.addToggle((t) =>
                t.setValue(p.settings.e2eeWriteV3)
                  .setDisabled(!hasSalt && !p.settings.e2eeWriteV3)
                  .onChange(async (v) => {
                    await p.enableE2eeV3(v);
                    reRender();
                  })
              );
            },
          },
          {
            name: "Re-encrypt all files",
            desc:
              "Force every file to be re-uploaded as encrypted. Use this if some files " +
              "were synced before E2EE was enabled and are still stored in plaintext on the server." +
              " Also migrates existing files to the per-install salt (v3) once it is enabled above.",
            build: (s) =>
              s.addButton((btn) => {
                btn.setButtonText("Re-encrypt all files now")
                  .setCta()
                  .onClick(async () => {
                    if (!p.xSync) return;
                    btn.setButtonText("Re-encrypting…");
                    btn.setDisabled(true);
                    await p.xSync.triggerReEncrypt();
                    btn.setButtonText("Done — syncing now");
                    window.setTimeout(() => {
                      btn.setButtonText("Re-encrypt all files now");
                      btn.setDisabled(false);
                    }, 4000);
                  });
              }),
          },
        ],
      },

      // ── Exclusion list ──────────────────────────────────────────────────
      {
        heading: "Exclusion list",
        rows: [
          {
            name: "Excluded patterns",
            desc: "One glob pattern per line. Lines starting with # are comments.",
            build: (s) => {
              s.addTextArea((ta) =>
                ta.setPlaceholder("*.log\nsecrets/**")
                  .setValue(p.settings.exclusionList)
                  .onChange(async (v) => { p.settings.exclusionList = v; await p.saveSettings(); p.xSync?.scheduleFullReconcile(); })
              );
              s.settingEl.addClass("ion-setting-column");
            },
          },
        ],
      },

      // ── Support ─────────────────────────────────────────────────────────
      {
        rows: [
          {
            name: "Support IonSync",
            searchable: false,
            build: (s) => {
              s.setDesc("IonSync is free and open source. Tips are appreciated!");
              const coffeeLink = s.controlEl.createEl("a", {
                text: "☕ Buy me a coffee",
                href: "https://buymeacoffee.com/seanseanric",
                cls: "ion-support-link",
              });
              coffeeLink.setAttribute("target", "_blank");
              coffeeLink.setAttribute("rel", "noopener");
              s.settingEl.addClass("ion-support");
            },
          },
        ],
      },
    ];
  }
}
