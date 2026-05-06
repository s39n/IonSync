import type { PluginSettings } from "./main.js";

const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","bmp","svg","webp","ico","tif","tiff","psd","ai","heic","heif"]);
const AUDIO_EXTS = new Set(["mp3","wav","ogg","flac","aac","m4a","wma","aiff","opus"]);
const VIDEO_EXTS = new Set(["mp4","mkv","avi","mov","wmv","flv","webm","m4v","mpeg","mpg","3gp"]);

export class ExclusionFilter {
  private patterns: RegExp[];

  constructor(private settings: PluginSettings) {
    this.patterns = (settings.exclusionList ?? "")
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !p.startsWith("#"))
      .map((p) => this.patternToRegex(p));
  }

  isExcluded(path: string): boolean {
    // Obsidian trash folder
    if (this.isTrashPath(path) && !this.settings.syncTrash) return true;

    // .obsidian/* settings files — checked before hidden-file rule
    if (this.isThemesOrSnippets(path)) return !this.settings.syncThemesAndSnippets;
    if (this.isSnippets(path)) return !this.settings.syncSnippets || !this.settings.syncThemesAndSnippets;
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

  private isTrashPath(p: string) { return p === ".trash" || p.startsWith(".trash/"); }
  private isHiddenPath(p: string) {
    return p.startsWith(".") || p.includes("/.");
  }
  private isThemesOrSnippets(p: string) { return p.startsWith(".obsidian/themes/"); }
  private isSnippets(p: string) { return p.startsWith(".obsidian/snippets/"); }
  private isMainSettings(p: string) { return p === ".obsidian/app.json"; }
  private isAppearanceSettings(p: string) { return p === ".obsidian/appearance.json"; }
  private isHotkeys(p: string) { return p === ".obsidian/hotkeys.json"; }
  private isActiveCorePlugins(p: string) {
    return p === ".obsidian/core-plugins.json" || p === ".obsidian/core-plugins-migration.json";
  }
  private isCorePluginSettings(p: string) {
    return p.startsWith(".obsidian/plugins/") && !p.startsWith(".obsidian/plugins/ion-sync/");
  }
  private isActiveCommunityPlugins(p: string) { return p === ".obsidian/community-plugins.json"; }
  private isInstalledCommunityPlugins(p: string) { return p.startsWith(".obsidian/plugins/"); }

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
