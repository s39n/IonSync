import { Modal } from "obsidian";
import type { IonSyncPlugin } from "../main.js";

export class ActivityLogModal extends Modal {
  private timer: number | null = null;
  private listEl: HTMLElement | null = null;
  private lastLen = -1;

  constructor(private plugin: IonSyncPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Activity Log" });

    this.listEl = contentEl.createEl("ul");
    this.listEl.style.cssText = "max-height:400px;overflow-y:auto;font-family:monospace;font-size:12px;";

    this._render();
    // Live refresh while the modal is open so activity appears without reopening.
    this.timer = window.setInterval(() => this._render(), 1_000);
  }

  /** Rebuilds the list only when the log actually changed, so an idle modal
   *  keeps its scroll position and doesn't flicker. */
  private _render(): void {
    if (!this.listEl) return;
    const log = this.plugin.xSync.getActivityLog();
    if (log.length === this.lastLen) return;
    this.lastLen = log.length;

    this.listEl.empty();
    if (log.length === 0) {
      const li = this.listEl.createEl("li", { text: "No activity yet." });
      li.style.listStyle = "none";
      return;
    }
    for (const entry of log) this.listEl.createEl("li", { text: entry });
  }

  override onClose(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.contentEl.empty();
  }
}
