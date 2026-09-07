import { Modal, Notice } from "obsidian";
import type { IonSyncPlugin } from "../main.js";

export class ActivityLogModal extends Modal {
  private timer: number | null = null;
  private sheetEl: HTMLElement | null = null;
  private lastLen = -1;

  constructor(private plugin: IonSyncPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Header row: title + a "Copy all" button.
    const header = contentEl.createDiv({ cls: "ion-activity-header" });
    header.createEl("h2", { text: "Activity log" });

    const copyBtn = header.createEl("button", { text: "Copy all" });
    copyBtn.onclick = () => { void this._copyAll(); };

    // A white "log sheet" panel — paper-like regardless of the Obsidian theme.
    this.sheetEl = contentEl.createDiv({ cls: "ion-activity-sheet" });

    this._render();
    // Live refresh while the modal is open so activity appears without reopening.
    this.timer = window.setInterval(() => this._render(), 1_000);
  }

  /** Copy the full activity log to the clipboard. */
  private async _copyAll(): Promise<void> {
    const text = this.plugin.xSync.getActivityLog().join("\n");
    if (!text) { new Notice("Activity log is empty"); return; }
    try {
      await navigator.clipboard.writeText(text);
      new Notice("Activity log copied");
    } catch {
      new Notice("Couldn't copy — select the text and copy manually");
    }
  }

  /** Rebuilds the sheet only when the log actually changed, so an idle modal
   *  keeps its scroll position and doesn't flicker. */
  private _render(): void {
    if (!this.sheetEl) return;
    const log = this.plugin.xSync.getActivityLog();
    if (log.length === this.lastLen) return;
    this.lastLen = log.length;

    this.sheetEl.empty();
    if (log.length === 0) {
      this.sheetEl.createDiv({ text: "No activity yet.", cls: "ion-activity-empty" });
      return;
    }
    for (const entry of log) {
      // Faint ruled line between entries, like a printed log sheet.
      this.sheetEl.createDiv({ text: entry, cls: "ion-activity-line" });
    }
  }

  override onClose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.contentEl.empty();
  }
}
