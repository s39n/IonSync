import { Modal, SuggestModal, Notice } from "obsidian";
import type { FileHistoryResponseMsg, VersionEntry } from "@ionsync/protocol";
import { decryptFromBase64, isEncryptedBase64 } from "../Crypto.js";
import type { IonSyncPlugin } from "../main.js";

// ── VersionHistoryModal ────────────────────────────────────────────────────

/** Shows all stored versions for a specific file with preview, restore, and copy. */
export class VersionHistoryModal extends Modal {
  constructor(private plugin: IonSyncPlugin, private filePath: string) {
    super(plugin.app);
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ion-version-history-modal");

    contentEl.createEl("h2", { text: `Version history` });
    contentEl.createEl("p", {
      text: this.filePath,
      cls: "ion-file-path",
    });

    const loading = contentEl.createEl("p", { text: "Loading versions…", cls: "ion-loading" });

    let resp: FileHistoryResponseMsg;
    try {
      resp = await this.plugin.xSync.listVersionHistory(this.filePath);
    } catch {
      loading.setText("Failed to load versions — is the server connected?");
      return;
    }
    loading.remove();

    if (resp.versions.length === 0) {
      contentEl.createEl("p", { text: "No versions found for this file.", cls: "ion-loading" });
      return;
    }

    const list = contentEl.createDiv({ cls: "ion-version-list" });
    resp.versions.forEach((v, i) => {
      this._renderVersionRow(list, v, i, resp.versions.length);
    });
  }

  private _renderVersionRow(
    container: HTMLElement,
    v: VersionEntry,
    index: number,
    total: number
  ): void {
    const isLatest = index === 0;
    const versionNum = total - index;
    const dateStr = new Date(v.mtime).toLocaleString();
    const sha = v.sha1 ? v.sha1.substring(0, 8) : "—";

    const row = container.createDiv({ cls: "ion-version-row" });

    // ── Header line ──
    const header = row.createDiv({ cls: "ion-version-header" });

    const meta = header.createDiv({ cls: "ion-version-meta" });
    meta.createSpan({ text: `#${versionNum}`, cls: "ion-version-num" });
    meta.createSpan({ text: dateStr, cls: "ion-version-date" });
    if (isLatest) meta.createSpan({ text: "latest", cls: "ion-badge-latest" });
    meta.createSpan({ text: sha + "…", cls: "ion-version-sha", attr: { title: v.sha1 ?? "" } });

    const actions = header.createDiv({ cls: "ion-version-actions" });

    // Preview toggle button
    const previewBtn = actions.createEl("button", { text: "Preview", cls: "ion-btn" });
    const previewArea = row.createDiv({ cls: "ion-preview-area" });
    previewArea.style.display = "none";

    previewBtn.onclick = async () => {
      if (previewArea.style.display !== "none") {
        previewArea.style.display = "none";
        previewBtn.textContent = "Preview";
        return;
      }
      previewBtn.textContent = "Loading…";
      previewBtn.disabled = true;

      try {
        const text = await this._fetchVersionText(v.mtime);
        previewArea.empty();
        const previewHeader = previewArea.createDiv({ cls: "ion-preview-header" });
        previewHeader.createSpan({ text: "📄 Preview", cls: "ion-preview-label" });
        previewHeader.createSpan({
          text: `Version #${versionNum} · ${dateStr}`,
          cls: "ion-preview-version-info",
        });
        const pre = previewArea.createEl("pre", { cls: "ion-preview-content" });
        pre.textContent = text;
        previewArea.style.display = "";
        previewBtn.textContent = "Hide";
      } catch (e) {
        previewArea.textContent = String(e instanceof Error ? e.message : e);
        previewArea.style.display = "";
        previewBtn.textContent = "Preview";
      }
      previewBtn.disabled = false;
    };

    // Restore button
    const restoreBtn = actions.createEl("button", { text: "Restore", cls: "ion-btn ion-btn-primary" });
    restoreBtn.onclick = async () => {
      restoreBtn.disabled = true;
      restoreBtn.textContent = "Restoring…";
      try {
        const text = await this._fetchVersionText(v.mtime);
        await this.plugin.app.vault.adapter.write(this.filePath, text);
        // Push immediately so connected peers receive the restored content
        // without waiting for the next sync cycle.
        await this.plugin.xSync.pushFile(this.filePath);
        new Notice(`Restored ${this.filePath} to version #${versionNum}`);
        restoreBtn.textContent = "Restored ✓";
      } catch (e) {
        new Notice(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
        restoreBtn.textContent = "Failed";
        restoreBtn.disabled = false;
      }
    };

    // Copy button
    const copyBtn = actions.createEl("button", { text: "Copy", cls: "ion-btn" });
    copyBtn.onclick = async () => {
      copyBtn.disabled = true;
      copyBtn.textContent = "Copying…";
      try {
        const text = await this._fetchVersionText(v.mtime);
        await navigator.clipboard.writeText(text);
        new Notice("Copied to clipboard");
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => { copyBtn.textContent = "Copy"; copyBtn.disabled = false; }, 2000);
      } catch (e) {
        new Notice(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
        copyBtn.textContent = "Copy";
        copyBtn.disabled = false;
      }
    };
  }

  /** Downloads a specific version and decrypts it if E2EE is active. */
  private async _fetchVersionText(mtime: number): Promise<string> {
    const resp = await this.plugin.xSync.downloadVersion(this.filePath, mtime);
    const content: string = resp?.content ?? "";
    if (!content) throw new Error("Server returned empty content for this version.");

    if (isEncryptedBase64(content)) {
      const key = await this.plugin.xSync.getE2eeKey();
      if (!key) {
        throw new Error(
          "This version is encrypted but E2EE is not enabled in your plugin settings. " +
          "Enable encryption and enter your vault key to preview encrypted files."
        );
      }
      const plainBuf = await decryptFromBase64(key, content);
      return new TextDecoder().decode(plainBuf);
    }

    return Buffer.from(content, "base64").toString("utf-8");
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

// ── FilesHistoryModal ──────────────────────────────────────────────────────

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
      this.files = resp.versions
        .map((v: any) => (v as any).path as string)
        .filter(Boolean);
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
