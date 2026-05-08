import { Notice, Platform, setIcon } from "obsidian";
import type { XSync } from "./XSync.js";

export enum NotifyType {
  CONNECTED,
  NOT_CONNECTED,
  CONNECTION_LOST,
  SYNCING,
  AUTO_SYNC_DISABLED
}

export class XNotify {
  private statusBarItem: HTMLElement | null = null;
  private floatingIcon: HTMLElement | null = null;
  private pendingCount = 0;

  constructor(private xSync: XSync) {
    // Only create the floating corner icon on mobile devices
    if (Platform.isMobile) {
      this.createMobileFloatingIcon();
    }
  }

  // ✅ RESTORED: Desktop Status Bar Hook
  makeStatusBarItem(el: HTMLElement): void {
    this.statusBarItem = el;
    this.statusBarItem.addClass("ionsync-status-bar");
    this.notifyStatus(NotifyType.NOT_CONNECTED); // Initialize state
  }

  // ✅ RESTORED: Colored Notifications
  showNotification(color: string, message: string): void {
    const frag = document.createDocumentFragment();
    const span = frag.createEl("span", { text: message });
    span.style.color = color;
    new Notice(frag);
  }

  private createMobileFloatingIcon() {
    this.floatingIcon = document.createElement("div");
    this.floatingIcon.addClass("ionsync-mobile-status");
    
    // Tap the icon to manually force a sync
    this.floatingIcon.addEventListener("click", () => {
      if (!this.xSync.isSyncing) {
        new Notice("Manual sync triggered");
        void this.xSync.sync();
      }
    });

    document.body.appendChild(this.floatingIcon);
  }

  notifyStatus(type: NotifyType): void {
    let iconName = "wifi-off";
    let color = "var(--text-muted)";
    let text = "Disconnected";
    let isSyncing = false;

    switch (type) {
      case NotifyType.CONNECTED:
        iconName = "check-circle";
        color = "var(--color-green)";
        text = this.pendingCount > 0 ? `Connected (${this.pendingCount} pending)` : "Connected (Synced)";
        break;
      case NotifyType.SYNCING:
        iconName = "sync";
        color = "var(--color-blue)";
        text = "Syncing...";
        isSyncing = true;
        break;
      case NotifyType.CONNECTION_LOST:
      case NotifyType.NOT_CONNECTED:
        iconName = "wifi-off";
        color = "var(--color-red)";
        text = "Disconnected";
        break;
      case NotifyType.AUTO_SYNC_DISABLED:
        iconName = "pause-circle";
        color = "var(--color-orange)";
        text = "Auto-sync paused";
        break;
    }

    // 1. Update Desktop Status Bar
    if (this.statusBarItem) {
      this.statusBarItem.empty();
      const iconEl = this.statusBarItem.createSpan({ cls: "ionsync-status-icon" });
      setIcon(iconEl, iconName);
      iconEl.style.color = color;
      
      if (isSyncing) {
        iconEl.addClass("syncing");
      } else {
        iconEl.removeClass("syncing");
      }
      
      this.statusBarItem.createSpan({ text: ` IonSync: ${text}` });
    }

    // 2. Update Mobile Floating Icon
    if (this.floatingIcon) {
      this.floatingIcon.empty();
      
      if (isSyncing) {
        this.floatingIcon.addClass("syncing");
      } else {
        this.floatingIcon.removeClass("syncing");
      }

      setIcon(this.floatingIcon, iconName);
      this.floatingIcon.style.color = color;
    }
  }

  updatePendingCount(count: number): void {
    this.pendingCount = count;
    // Update the UI if connected but idle so the pending count shows up
    if (this.xSync.ws && this.xSync.ws.isConnected && !this.xSync.isSyncing) {
      this.notifyStatus(NotifyType.CONNECTED);
    }
  }

  setSyncSummary(up: number, down: number): void {
    if (up > 0 || down > 0) {
      new Notice(`Sync complete: ↑${up} ↓${down}`);
    }
    this.notifyStatus(NotifyType.CONNECTED);
  }

  cleanup(): void {
    if (this.floatingIcon) {
      this.floatingIcon.remove();
      this.floatingIcon = null;
    }
    if (this.statusBarItem) {
      this.statusBarItem.empty();
    }
  }
}