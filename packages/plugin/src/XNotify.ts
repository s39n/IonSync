import { Menu, Notice, Platform, type MenuItem } from "obsidian";
import { VersionHistoryModal, FilesHistoryModal, ActivityLogModal, ConflictsModal } from "./modals/index.js";
import { appInternals } from "./obsidian-internals.js";
import type { XSync } from "./XSync.js";

export const STATUS_OK = "#4caf50";
export const STATUS_ERROR = "#f44336";
export const STATUS_WARN = "#ff9800";
export const STATUS_SYNC = "#2196f3";

export enum NotifyType {
  PLUGIN_DISABLED = "Sync paused",
  NOT_CONNECTED = "Not connected",
  CONNECTION_LOST = "Connection lost",
  CONNECTED = "Connected",
  SYNCING = "Syncing…",
  SYNC_COMPLETED = "Sync complete",
  AUTO_SYNC_DISABLED = "Auto-sync off",
}

export class XNotify {
  private statusBarItem: HTMLElement | null = null;
  private statusBarIcon: HTMLElement | null = null;
  private statusBarMsg: HTMLElement | null = null;
  private _currentStatusLabel = "";

  private mobileIndicator: HTMLElement | null = null;
  private mobileIcon: HTMLElement | null = null;
  private mobileBadge: HTMLElement | null = null;

  private msgTimeout: number | null = null;
  private pendingNoticeTimeout: number | null = null;
  /** Safety net that stops the mobile spinner if a sync ends without a clean
   *  summary (e.g. a missed sync_done). */
  private _spinWatchdog: number | null = null;
  private lastNoticeType: string | null = null;
  private _pendingCount = 0;

  /** Timestamp (ms) of the last CONNECTION_LOST event; 0 when connected. */
  private _lastDisconnectTime = 0;
  /** If a reconnect arrives within this window, suppress both disconnect and connect notices. */
  private static readonly TRANSIENT_MS = 5_000;

  constructor(private xSync: XSync) {}

  makeStatusBarItem(el: HTMLElement): void {
    this.statusBarItem = el;
    el.addClass("ionsync-status-bar");
    el.setAttr("title", "IonSync");

    const wrap = el.createSpan({ cls: "ionsync-icon-wrap" });
    this.statusBarIcon = wrap.createSpan();
    this.statusBarIcon.style.cssText = `padding-right:4px;color:${STATUS_ERROR};`;
    this.statusBarIcon.append(this.xSync.plugin.buildSVGIcon());
    this.statusBarMsg = wrap.createSpan();
    this.statusBarMsg.hide();

    el.onClickEvent((evt) => this.showMenu(evt));

    // MOBILE: Create the floating corner icon with the notification badge
    if (Platform.isMobile) {
      this.mobileIndicator = document.body.createDiv();
      this.mobileIndicator.addClass("ionsync-mobile-status");
      
      this.mobileIcon = this.mobileIndicator.createSpan();
      this.mobileIcon.style.cssText = `color:${STATUS_ERROR}; display:flex; align-items:center; justify-content:center;`;
      this.mobileIcon.append(this.xSync.plugin.buildSVGIcon());
      
      this.mobileBadge = this.mobileIndicator.createDiv();
      this.mobileBadge.addClass("ionsync-mobile-badge");
      
      this.mobileIndicator.addEventListener("click", (e) => this.showMenu(e as MouseEvent));
    }
  }

  private showMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const plugin = this.xSync.plugin;
    const connected = this.xSync.ws.isConnected;
    const paused = !plugin.settings.syncEnabled;
    const autoSync = plugin.settings.autoSync;

    let statusItem: MenuItem | null = null;
    menu.addItem((i) => {
      statusItem = i;
      i.setTitle(`Status: ${this._statusLine()}`).setIcon("info").setDisabled(true);
    });
    // While the menu is open, refresh the status line in place so the file being
    // synced updates live without the user reopening the menu.
    const statusTimer = window.setInterval(() => {
      statusItem?.setTitle(`Status: ${this._statusLine()}`);
    }, 400);
    menu.onHide(() => window.clearInterval(statusTimer));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle(paused ? "Resume Sync" : "Pause Sync").setIcon(paused ? "play" : "pause")
        // Toggle: new state is the opposite of current. `paused` already is the
        // opposite of syncEnabled, so assign it directly. (Was `!paused`, which
        // re-set syncEnabled to its current value — a no-op, so Pause did nothing.)
        .onClick(async () => { plugin.settings.syncEnabled = paused; await plugin.saveSettings(); })
    );
    menu.addItem((i) =>
      i.setTitle(autoSync ? "Disable Auto-Sync" : "Enable Auto-Sync").setIcon("refresh-cw")
        .onClick(async () => { plugin.settings.autoSync = !autoSync; await plugin.saveSettings(); })
    );
    if (connected) {
      menu.addItem((i) => i.setTitle("Sync now").setIcon("sync").onClick(() => { void this.xSync.sync(); }));
    }
    menu.addSeparator();
    const activeFile = plugin.app.workspace.getActiveFile();
    if (activeFile) {
      menu.addItem((i) =>
        i.setTitle("File version history").setIcon("history")
          .onClick(() => { new VersionHistoryModal(plugin, activeFile.path).open(); })
      );
    }
    menu.addItem((i) =>
      i.setTitle("Trash viewer").setIcon("trash").onClick(() => { new FilesHistoryModal(plugin, true).open(); })
    );
    menu.addItem((i) =>
      i.setTitle("Activity log").setIcon("list").onClick(() => { new ActivityLogModal(plugin).open(); })
    );
    menu.addItem((i) =>
      i.setTitle("Conflicts").setIcon("swords").onClick(() => { new ConflictsModal(plugin).open(); })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Settings").setIcon("settings").onClick(() => {
        const setting = appInternals(plugin.app).setting;
        setting?.open?.();
        setting?.openTabById?.("ion-sync");
      })
    );
    menu.showAtMouseEvent(evt);
  }

  /** The current human-readable status line (e.g. "Syncing… ↓ note.md"),
   *  used by the live-updating status menu item. */
  private _statusLine(): string {
    return this._currentStatusLabel || (this.xSync.ws.isConnected ? "Connected" : "Disconnected");
  }

  /** Returns the theme's accent color (--color-accent CSS variable),
   *  falling back to STATUS_OK green if the variable is not set. */
  private _themeAccent(): string {
    try {
      const c = getComputedStyle(document.body).getPropertyValue("--color-accent").trim();
      return c || STATUS_OK;
    } catch {
      return STATUS_OK;
    }
  }

  private setColor(color: string): void {
    if (this.statusBarIcon) this.statusBarIcon.style.color = color;
    if (this.mobileIcon) this.mobileIcon.style.color = color;
  }

  setStatusMessage(text: string, keep = false, duration = 2_000): void {
    if (!this.statusBarMsg) return;
    this._currentStatusLabel = text;
    this.statusBarMsg.innerText = text;
    if (this.statusBarItem) this.statusBarItem.setAttr("title", `IonSync — ${text}`);
    if (this.msgTimeout !== null) { window.clearTimeout(this.msgTimeout); this.msgTimeout = null; }
    if (!keep) {
      this.msgTimeout = window.setTimeout(() => {
        this.msgTimeout = null;
        const fallback = this._pendingCount > 0
          ? `${this._pendingCount} remaining`
          : (this.xSync.ws.isConnected ? "Connected" : "Disconnected");
        this._currentStatusLabel = fallback;
        if (this.statusBarMsg) this.statusBarMsg.innerText = fallback;
        if (this.statusBarItem) this.statusBarItem.setAttr("title", `IonSync — ${fallback}`);
      }, duration);
    }
  }

  updatePendingCount(count: number): void {
    this._pendingCount = count;
    
    // 1. Update Mobile Badge
    if (this.mobileBadge) {
      if (count > 0) {
        this.mobileBadge.innerText = count > 99 ? "99+" : count.toString();
        this.mobileBadge.addClass("visible");
      } else {
        this.mobileBadge.removeClass("visible");
      }
    }

    // 2. Update Desktop Status Bar Text
    if (this.xSync.isSyncing || !this.statusBarMsg || this.msgTimeout !== null) return;
    const label = count > 0 ? `${count} remaining` : (this.xSync.ws.isConnected ? "Connected" : "Disconnected");
    this._currentStatusLabel = label;
    this.statusBarMsg.innerText = label;
    if (this.statusBarItem) this.statusBarItem.setAttr("title", `IonSync — ${label}`);
  }

  updateSyncProgress(detail: string): void {
    if (!this.statusBarMsg) return;
    const text = `${NotifyType.SYNCING} ${detail}`;
    this._currentStatusLabel = text;
    if (this.msgTimeout !== null) { window.clearTimeout(this.msgTimeout); this.msgTimeout = null; }
    this.statusBarMsg.innerText = text;
    if (this.statusBarItem) this.statusBarItem.setAttr("title", `IonSync — ${text}`);
    // Only spin during an actual sync session. A live single-file push from
    // another device also runs _applyServerFile → updateSyncProgress, but it is
    // NOT followed by sync_done/setSyncSummary, so spinning here would leave the
    // mobile icon spinning forever.
    if (this.mobileIndicator && this.xSync.isSyncing) {
      this.mobileIndicator.addClass("syncing");
      this._armSpinWatchdog();
    }
  }

  /** (Re)arms a timeout that force-stops the spinner if no progress arrives for
   *  a while and we are no longer syncing — covers a missed sync_done. */
  private _armSpinWatchdog(): void {
    if (this._spinWatchdog !== null) window.clearTimeout(this._spinWatchdog);
    this._spinWatchdog = window.setTimeout(() => {
      this._spinWatchdog = null;
      if (!this.xSync.isSyncing) this.mobileIndicator?.removeClass("syncing");
    }, 10_000);
  }

  /** Stops the mobile spinner and cancels its watchdog. */
  private _stopSpin(): void {
    this.mobileIndicator?.removeClass("syncing");
    if (this._spinWatchdog !== null) { window.clearTimeout(this._spinWatchdog); this._spinWatchdog = null; }
  }

  setSyncSummary(up: number, down: number): void {
    const accent = this._themeAccent();
    this.setColor(accent);
    const parts: string[] = [];
    if (up > 0) parts.push(`↑${up}`);
    if (down > 0) parts.push(`↓${down}`);
    const summary = parts.length > 0 ? `Synced ${parts.join(" ")}` : "Up to date";
    if ((this.xSync.plugin.settings.notifications ?? 0) > 1) this._makeNotice(accent, summary);
    this.setStatusMessage(summary, false, 5_000);

    this._stopSpin();
  }

  notifyStatus(type: NotifyType): void {
    const level = this.xSync.plugin.settings.notifications ?? 0;

    if (type === NotifyType.SYNCING) {
      this.mobileIndicator?.addClass("syncing");
      this._armSpinWatchdog();
    } else {
      this._stopSpin();
    }

    switch (type) {
      case NotifyType.PLUGIN_DISABLED:
      case NotifyType.NOT_CONNECTED:
        if (level > 0) this._makeNotice(STATUS_ERROR, type);
        this.setColor(STATUS_ERROR);
        this.setStatusMessage(type, false);
        break;
      case NotifyType.CONNECTION_LOST:
        this._lastDisconnectTime = Date.now();
        if (level > 0) this._makeNotice(STATUS_ERROR, type);
        this.setColor(STATUS_ERROR);
        this.setStatusMessage(type, false);
        break;
      case NotifyType.CONNECTED: {
        const wasTransient =
          this._lastDisconnectTime > 0 &&
          Date.now() - this._lastDisconnectTime < XNotify.TRANSIENT_MS;
        this._lastDisconnectTime = 0;
        const accent = this._themeAccent();
        if (wasTransient) {
          // The connection blipped back within the threshold — cancel the
          // pending "Connection lost" notice and show nothing for CONNECTED.
          if (this.pendingNoticeTimeout !== null) {
            window.clearTimeout(this.pendingNoticeTimeout);
            this.pendingNoticeTimeout = null;
          }
        } else if (level > 0) {
          this._makeNotice(accent, type);
        }
        this.setColor(accent);
        this.setStatusMessage(this._pendingCount > 0 ? `${this._pendingCount} remaining` : type, true);
        break;
      }
      case NotifyType.SYNCING:
        if (level > 1) this._makeNotice(STATUS_SYNC, type);
        this.setColor(STATUS_SYNC);
        this.setStatusMessage(type, true);
        break;
      case NotifyType.SYNC_COMPLETED: {
        const accent = this._themeAccent();
        if (level > 1) this._makeNotice(accent, type);
        this.setColor(accent);
        this.setStatusMessage(type, false, 5_000);
        break;
      }
      case NotifyType.AUTO_SYNC_DISABLED:
        if (level > 1) this._makeNotice(STATUS_WARN, type);
        this.setColor(STATUS_WARN);
        this.setStatusMessage(type, false);
        break;
    }
  }

  showNotification(color: string, text: string, delay = 0): void {
    window.clearTimeout(this.pendingNoticeTimeout!);
    this.pendingNoticeTimeout = window.setTimeout(() => {
      this.pendingNoticeTimeout = null;
      const el = new Notice("", 4_000).messageEl;
      const wrap = el.createSpan({ cls: "ionsync-icon-wrap" });
      const icon = wrap.createSpan();
      icon.style.cssText = `padding-right:4px;color:${color};`;
      icon.append(this.xSync.plugin.buildSVGIcon());
      wrap.createSpan({ text });
    }, delay);
  }

  private _makeNotice(color: string, text: string): void {
    if (this.lastNoticeType === text && this.pendingNoticeTimeout !== null) return;
    this.lastNoticeType = text;
    this.showNotification(color, text, 2_000);
  }

  cleanup(): void {
    if (this.msgTimeout !== null) { window.clearTimeout(this.msgTimeout); this.msgTimeout = null; }
    if (this.pendingNoticeTimeout !== null) { window.clearTimeout(this.pendingNoticeTimeout); this.pendingNoticeTimeout = null; }
    if (this._spinWatchdog !== null) { window.clearTimeout(this._spinWatchdog); this._spinWatchdog = null; }
    if (this.mobileIndicator) { this.mobileIndicator.remove(); this.mobileIndicator = null; }
  }
}
