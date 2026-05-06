import { Modal, SuggestModal } from "obsidian";
import type { FileHistoryResponseMsg } from "@ionsync/protocol";
import type { IonSyncPlugin } from "../main.js";

/** Shows all stored versions for a specific file and lets the user restore one */
export class VersionHistoryModal extends Modal {
  constructor(private plugin: IonSyncPlugin, private filePath: string) {
    super(plugin.app);
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Version history: ${this.filePath}` });
    const loading = contentEl.createEl("p", { text: "Loading…" });

    let resp: FileHistoryResponseMsg;
    try {
      resp = await this.plugin.xSync.listVersionHistory(this.filePath);
    } catch {
      loading.setText("Failed to load versions.");
      return;
    }
    loading.remove();

    if (resp.versions.length === 0) {
      contentEl.createEl("p", { text: "No versions found." });
      return;
    }

    for (const v of resp.versions) {
      const row = contentEl.createDiv();
      row.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;";
      row.createEl("span", { text: new Date(v.mtime).toLocaleString() });
      const btn = row.createEl("button", { text: "Restore" });
      btn.onclick = async () => {
        btn.disabled = true;
        btn.setText("Restoring…");
        try {
          const fileResp = await this.plugin.xSync.downloadVersion(this.filePath);
          if (fileResp.content) {
            const text = Buffer.from(fileResp.content, "base64").toString("utf-8");
            await this.plugin.app.vault.adapter.write(this.filePath, text);
            btn.setText("Done ✓");
          }
        } catch (e) {
          console.error("Restore failed:", e);
          btn.setText("Failed");
        }
      };
    }
  }

  override onClose(): void { this.contentEl.empty(); }
}

/** Trash Viewer — lists all (or only deleted) files stored on the server */
export class FilesHistoryModal extends SuggestModal<string> {
  private files: string[] = [];

  constructor(private plugin: IonSyncPlugin, private deletedOnly: boolean) {
    super(plugin.app);
    this.setPlaceholder("Search files…");
  }

  override async onOpen(): Promise<void> {
    super.onOpen();
    try {
      const resp = await this.plugin.xSync.listVersionHistory("/");
      // resp.versions are VersionEntry[] — use path field from the response
      this.files = resp.versions.map((v) => (v as any).path as string).filter(Boolean);
    } catch {
      this.files = [];
    }
  }

  override getSuggestions(query: string): string[] {
    return this.files.filter((f) => f.toLowerCase().includes(query.toLowerCase()));
  }

  override renderSuggestion(filePath: string, el: HTMLElement): void {
    el.createEl("div", { text: filePath });
  }

  override async onChooseSuggestion(filePath: string): Promise<void> {
    new VersionHistoryModal(this.plugin, filePath).open();
  }
}
