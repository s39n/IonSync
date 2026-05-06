import { Menu, Notice, Platform } from "obsidian";
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
  private mobileIndicator: HTMLElement | null = null;
  private mobileIcon: HTMLElement | null = null;

  private msgTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingNoticeTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastNoticeType: string | null = null;
  private _pendingCount = 0;

  constructor(private xSync: XSync) {}

  makeStatusBarItem(el: HTMLElement): void {
    this.statusBarItem = el;
    el.addClass("ionsync-status-bar");
    el.setAttr("title", "IonSync");

    const wrap = el.createEl("span");
    wrap.style.cssText = "vertical-align:middle;display:inline-flex;align-items:center;";
    this.statusBarIcon = wrap.createEl("span");
    this.statusBarIcon.style.cssText = `padding-right:4px;color:${STATUS_ERROR};`;
    this.statusBarIcon.innerHTML = this.xSync.plugin.getSVGIcon();
    this.statusBarMsg = wrap.createEl("span");

    el.onClickEvent((evt) => this.showMenu(evt));

    if (Platform.isMobile) {
      const appContainer = document.querySelector(".app-container");
      if (appContainer) {
        this.mobileIndicator = (appContainer as HTMLElement).createEl("div");
        this.mobileIndicator.addClass("ionsync-mobile-indicator");
        this.mobileIcon = this.mobileIndicator.createEl("span");
        this.mobileIcon.style.color = STATUS_ERROR;
        this.mobileIcon.innerHTML = this.xSync.plugin.getSVGIcon();
        this.mobileIndicator.addEventListener("click", (e) => this.showMenu(e as MouseEvent));
      }
    }
  }

  private showMenu(evt: MouseEvent): void {
    // Dynamic import to avoid circular references at module load time
    const { VersionHistoryModal, FilesHistoryModal, ActivityLogModal } = require("./modals/index.js") as typeof import("./modals/index.js");
    const menu = new Menu();
    const plugin = this.xSync.plugin;
    const connected = this.xSync.ws.isConnected;
    const paused = !plugin.settings.syncEnabled;
    const autoSync = plugin.settings.autoSync;

    menu.addItem((i) =>
      i.setTitle(`Status: ${this.lastNoticeType ?? (connected ? "Connected" : "Disconnected")}`).setIcon("info").setDisabled(true)
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle(paused ? "Resume Sync" : "Pause Sync").setIcon(paused ? "play" : "pause")
        .onClick(async () => { plugin.settings.syncEnabled = !paused; await plugin.saveSettings(); })
    );
    menu.addItem((i) =>
      i.setTitle(autoSync ? "Disable Auto-Sync" : "Enable Auto-Sync").setIcon("refresh-cw")
        .onClick(async () => { plugin.settings.autoSync = !autoSync; await plugin.saveSettings(); })
    );
    if (connected) {
      menu.addItem((i) => i.setTitle("Sync Now").setIcon("sync").onClick(() => { void this.xSync.sync(); }));
    }
    menu.addSeparator();
    const activeFile = plugin.app.workspace.getActiveFile();
    if (activeFile) {
      menu.addItem((i) =>
        i.setTitle("File Version History").setIcon("history")
          .onClick(() => { new VersionHistoryModal(plugin, activeFile.path).open(); })
      );
    }
    menu.addItem((i) =>
      i.setTitle("Trash Viewer").setIcon("trash").onClick(() => { new FilesHistoryModal(plugin, true).open(); })
    );
    menu.addItem((i) =>
      i.setTitle("Activity Log").setIcon("list").onClick(() => { new ActivityLogModal(plugin).open(); })
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Settings").setIcon("settings").onClick(() => {
        (plugin.app as any).setting?.open();
        (plugin.app as any).setting?.openTabById("ion-sync");
      })
    );
    menu.showAtMouseEvent(evt);
  }

  private setColor(color: string): void {
    if (this.statusBarIcon) this.statusBarIcon.style.color = color;
    if (this.mobileIcon) this.mobileIcon.style.color = color;
  }

  setStatusMessage(text: string, keep = false, duration = 2_000): void {
    if (!this.statusBarMsg) return;
    this.statusBarMsg.innerText = text;
    if (this.msgTimeout !== null) { clearTimeout(this.msgTimeout); this.msgTimeout = null; }
    if (!keep) {
      this.msgTimeout = setTimeout(() => {
        this.msgTimeout = null;
        if (this.statusBarMsg) {
          this.statusBarMsg.innerText = this._pendingCount > 0
            ? `${this._pendingCount} pending`
            : (this.xSync.ws.isConnected ? "Connected" : "");
        }
      }, duration);
    }
  }

  updatePendingCount(count: number): void {
    this._pendingCount = count;
    if (this.xSync.isSyncing || !this.statusBarMsg || this.msgTimeout !== null) return;
    this.statusBarMsg.innerText = count > 0 ? `${count} pending` : (this.xSync.ws.isConnected ? "Connected" : "");
  }

  updateSyncProgress(detail: string): void {
    if (!this.statusBarMsg) return;
    if (this.msgTimeout !== null) { clearTimeout(this.msgTimeout); this.msgTimeout = null; }
    this.statusBarMsg.innerText = `${NotifyType.SYNCING} ${detail}`;
  }

  setSyncSummary(up: number, down: number): void {
    this.setColor(STATUS_OK);
    const parts: string[] = [];
    if (up > 0) parts.push(`↑${up}`);
    if (down > 0) parts.push(`↓${down}`);
    const summary = parts.length > 0 ? `Synced ${parts.join(" ")}` : "Up to date";
    if ((this.xSync.plugin.settings.notifications ?? 0) > 1) this._makeNotice(STATUS_OK, summary);
    this.setStatusMessage(summary, false, 5_000);
  }

  notifyStatus(type: NotifyType): void {
    const level = this.xSync.plugin.settings.notifications ?? 0;
    switch (type) {
      case NotifyType.PLUGIN_DISABLED:
      case NotifyType.CONNECTION_LOST:
      case NotifyType.NOT_CONNECTED:
        if (level > 0) this._makeNotice(STATUS_ERROR, type);
        this.setColor(STATUS_ERROR);
        this.setStatusMessage(type, false);
        break;
      case NotifyType.CONNECTED:
        if (level > 0) this._makeNotice(STATUS_OK, type);
        this.setColor(STATUS_OK);
        this.setStatusMessage(this._pendingCount > 0 ? `${this._pendingCount} pending` : type, true);
        break;
      case NotifyType.SYNCING:
        if (level > 1) this._makeNotice(STATUS_SYNC, type);
        this.setColor(STATUS_SYNC);
        this.setStatusMessage(type, true);
        break;
      case NotifyType.SYNC_COMPLETED:
        if (level > 1) this._makeNotice(STATUS_OK, type);
        this.setColor(STATUS_OK);
        this.setStatusMessage(type, false, 5_000);
        break;
      case NotifyType.AUTO_SYNC_DISABLED:
        if (level > 1) this._makeNotice(STATUS_WARN, type);
        this.setColor(STATUS_WARN);
        this.setStatusMessage(type, false);
        break;
    }
  }

  showNotification(color: string, text: string, delay = 0): void {
    clearTimeout(this.pendingNoticeTimeout!);
    this.pendingNoticeTimeout = setTimeout(() => {
      this.pendingNoticeTimeout = null;
      const el = new Notice("", 4_000).noticeEl;
      const wrap = el.createEl("span");
      wrap.style.cssText = "vertical-align:middle;display:inline-flex;align-items:center;";
      const icon = wrap.createEl("span");
      icon.style.cssText = `padding-right:4px;color:${color};`;
      icon.innerHTML = this.xSync.plugin.getSVGIcon();
      wrap.createEl("span", { text });
    }, delay);
  }

  private _makeNotice(color: string, text: string): void {
    if (this.lastNoticeType === text && this.pendingNoticeTimeout !== null) return;
    this.lastNoticeType = text;
    this.showNotification(color, text, 2_000);
  }

  cleanup(): void {
    if (this.msgTimeout !== null) { clearTimeout(this.msgTimeout); this.msgTimeout = null; }
    if (this.pendingNoticeTimeout !== null) { clearTimeout(this.pendingNoticeTimeout); this.pendingNoticeTimeout = null; }
    if (this.mobileIndicator) { this.mobileIndicator.remove(); this.mobileIndicator = null; }
  }
}
