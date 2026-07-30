import type { PluginSettings } from "./main.js";

const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","bmp","svg","webp","ico","tif","tiff","psd","ai","heic","heif"]);
const AUDIO_EXTS = new Set(["mp3","wav","ogg","flac","aac","m4a","wma","aiff","opus"]);
const VIDEO_EXTS = new Set(["mp4","mkv","avi","mov","wmv","flv","webm","m4v","mpeg","mpg","3gp"]);

export class ExclusionFilter {
  private patterns: RegExp[];
  private dangerousFiles: Set<string>;

  constructor(private settings: PluginSettings, private configDir: string) {
    this.patterns = (settings.exclusionList ?? "")
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.startsWith("#"))
      .map((p) => this.patternToRegex(p));

    // Immutable Rule: Never sync workspace state or dynamic UI graphs
    this.dangerousFiles = new Set([
      `${this.configDir}/workspace.json`,
      `${this.configDir}/workspace-mobile.json`,
      `${this.configDir}/sync.json`,
      `${this.configDir}/graph.json`
    ]);
  }

  isExcluded(path: string): boolean {
    // 1. IMMUTABLE RULE: Never sync workspace files (prevents infinite loops)
    if (this.dangerousFiles.has(path)) return true;

    // 1b. IMMUTABLE RULE: Never sync the DOS 8.3 short-name twin of the config
    //     folder. A recovery/restore tool that walked the disk via short paths
    //     can leave a literal "OBSIDI~1" folder beside ".obsidian"; it has no
    //     dot segment so it dodges every config/hidden rule below, and its
    //     plugin data.json files flap endlessly, minting conflict copies. Match
    //     the alias anywhere in the path (it also appears nested under corrupted
    //     short-name trees) and never upload or apply it.
    if (this.isShortNameConfig(path)) return true;

    // 2. IMMUTABLE RULE: Never sync IonSync's own plugin directory.
    //    It contains device-specific settings (deviceId, password, metadata)
    //    that must not bleed across devices regardless of any toggle.
    if (path.startsWith(`${this.configDir}/plugins/ion-sync/`)) return true;

    // 3. PER-DEVICE PROFILE: keep all Obsidian config local to this device.
    //    Overrides every individual config toggle below — nothing under the
    //    config folder is uploaded or applied. Notes still sync.
    if (this.settings.keepConfigLocal && path.startsWith(`${this.configDir}/`)) return true;

    // Obsidian trash folder
    if (this.isTrashPath(path) && !this.settings.syncTrash) return true;

    // config settings files — checked before hidden-file rule
    if (this.isThemesOrSnippets(path) || this.isSnippets(path)) return !this.settings.syncThemesAndSnippets;
    if (this.isMainSettings(path)) return !this.settings.syncMainSettings;
    if (this.isAppearanceSettings(path)) return !this.settings.syncAppearanceSettings;
    if (this.isHotkeys(path)) return !this.settings.syncHotkeys;
    if (this.isActiveCorePlugins(path)) return !this.settings.syncActiveCorePlugins;
    if (this.isCorePluginSettings(path)) return !this.settings.syncCorePluginSettings;
    if (this.isActiveCommunityPlugins(path)) return !this.settings.syncActiveCommunityPlugins;
    if (this.isInstalledCommunityPlugins(path)) return !this.settings.syncInstalledCommunityPlugins;

    // Hidden files (.obsidian/, .git/, etc.)
    if (!this.settings.syncHiddenFiles && this.isHiddenPath(path)) return true;

    // File-type filters
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (IMAGE_EXTS.has(ext)) return !this.settings.syncImages;
    if (AUDIO_EXTS.has(ext)) return !this.settings.syncAudio;
    if (VIDEO_EXTS.has(ext)) return !this.settings.syncVideos;
    if (ext === "pdf") return !this.settings.syncPDFs;

    // Custom exclusion patterns
    for (const re of this.patterns) {
      if (re.test(path)) return true;
    }

    return false;
  }

  private isShortNameConfig(p: string) { return /(^|\/)OBSIDI~\d+(\/|$)/i.test(p); }
  private isTrashPath(p: string) { return p === ".trash" || p.startsWith(".trash/"); }
  private isHiddenPath(p: string) {
    return p.startsWith(".") || p.includes("/.");
  }
  private isThemesOrSnippets(p: string) { return p.startsWith(`${this.configDir}/themes/`); }
  private isSnippets(p: string) { return p.startsWith(`${this.configDir}/snippets/`); }
  private isMainSettings(p: string) { return p === `${this.configDir}/app.json`; }
  private isAppearanceSettings(p: string) { return p === `${this.configDir}/appearance.json`; }
  private isHotkeys(p: string) { return p === `${this.configDir}/hotkeys.json`; }
  private isActiveCorePlugins(p: string) {
    return p === `${this.configDir}/core-plugins.json` || p === `${this.configDir}/core-plugins-migration.json`;
  }
  private isCorePluginSettings(p: string) {
    // Core plugin settings are JSON files sitting directly in .obsidian/ (e.g.
    // daily-notes.json, templates.json).  They live in the config root, never in
    // a subdirectory.  app.json, appearance.json, hotkeys.json, and core-plugins.json
    // are already handled by their own dedicated checks above.
    if (!p.startsWith(`${this.configDir}/`)) return false;
    const rest = p.slice(this.configDir.length + 1);
    return !rest.includes("/") && rest.endsWith(".json");
  }
  private isActiveCommunityPlugins(p: string) { return p === `${this.configDir}/community-plugins.json`; }
  private isInstalledCommunityPlugins(p: string) {
    return p.startsWith(`${this.configDir}/plugins/`);
  }

  private patternToRegex(pattern: string): RegExp {
    // Glob-style: * = any non-separator char, ** = anything
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§/g, ".*");
    return new RegExp(`(^|/)${escaped}(/|$)`);
  }
}