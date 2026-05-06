import { Modal } from "obsidian";
import type { IonSyncPlugin } from "../main.js";

export class ActivityLogModal extends Modal {
  constructor(private plugin: IonSyncPlugin) {
    super(plugin.app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Activity Log" });
    const log = this.plugin.xSync.getActivityLog();
    if (log.length === 0) {
      contentEl.createEl("p", { text: "No activity yet." });
      return;
    }
    const list = contentEl.createEl("ul");
    list.style.cssText = "max-height:400px;overflow-y:auto;font-family:monospace;font-size:12px;";
    for (const entry of log) {
      list.createEl("li", { text: entry });
    }
  }

  override onClose(): void { this.contentEl.empty(); }
}
