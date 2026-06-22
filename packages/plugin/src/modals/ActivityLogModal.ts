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
    const header = contentEl.createEl("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;";
    header.createEl("h2", { text: "Activity Log" }).style.margin = "0";

    const copyBtn = header.createEl("button", { text: "Copy all" });
    copyBtn.onclick = () => { void this._copyAll(); };

    // A white "log sheet" panel — paper-like regardless of the Obsidian theme.
    this.sheetEl = contentEl.createEl("div");
    this.sheetEl.style.cssText = [
      "max-height:400px",
      "overflow-y:auto",
      "background:#ffffff",
      "color:#1e1e1e",
      "border:1px solid #d0d0d0",
      "border-radius:6px",
      "padding:10px 14px",
      "font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace",
      "font-size:12px",
      "line-height:1.7",
      "box-shadow:inset 0 1px 3px rgba(0,0,0,0.08)",
      "white-space:pre-wrap",
      "word-break:break-word",
      // Obsidian disables text selection on UI chrome by default — re-enable it
      // here so log lines can be selected and copied.
      "user-select:text",
      "-webkit-user-select:text",
      "cursor:text",
    ].join(";");

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
      const empty = this.sheetEl.createEl("div", { text: "No activity yet." });
      empty.style.cssText = "color:#888;font-style:italic;";
      return;
    }
    for (const entry of log) {
      const line = this.sheetEl.createEl("div", { text: entry });
      // Faint ruled line between entries, like a printed log sheet.
      line.style.cssText = "padding:2px 0;border-bottom:1px dashed #ececec;";
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
