import { Modal, Notice } from "obsidian";
import type { ConflictSummary } from "@ionsync/protocol";
import { decryptFromBase64, isEncryptedBase64 } from "../Crypto.js";
import type { IonSyncPlugin } from "../main.js";

// ── ConflictsModal ──────────────────────────────────────────────────────────

/**
 * Review and resolve sync conflicts from inside Obsidian — the same records the
 * dashboard Conflicts panel shows. Each row is the LOSING side of a conflict
 * (an edit the server declined so it wouldn't clobber another device's change):
 * preview it, Restore it as the file's current content, or Dismiss it.
 */
export class ConflictsModal extends Modal {
  constructor(private plugin: IonSyncPlugin) {
    super(plugin.app);
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ion-version-history-modal");
    contentEl.createEl("h2", { text: "Sync conflicts" });

    if (!this.plugin.xSync.ws.isConnected) {
      contentEl.createEl("p", { text: "Not connected to the sync server.", cls: "ion-loading" });
      return;
    }

    const loading = contentEl.createEl("p", { text: "Loading conflicts…", cls: "ion-loading" });
    let conflicts: ConflictSummary[];
    try {
      conflicts = (await this.plugin.xSync.listConflicts()).conflicts;
    } catch {
      loading.setText("Failed to load conflicts — is the server connected?");
      return;
    }
    loading.remove();

    if (conflicts.length === 0) {
      contentEl.createEl("p", { text: "No pending conflicts. 🎉", cls: "ion-loading" });
      return;
    }

    contentEl.createEl("p", {
      text: `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} awaiting review. ` +
            `Restore replaces the current file with this version; Dismiss discards it.`,
      cls: "ion-file-path",
    });

    const list = contentEl.createDiv({ cls: "ion-version-list" });
    conflicts.forEach((c) => this._renderConflictRow(list, c));
  }

  private _renderConflictRow(container: HTMLElement, c: ConflictSummary): void {
    const row = container.createDiv({ cls: "ion-version-row" });

    const header = row.createDiv({ cls: "ion-version-header" });
    const meta = header.createDiv({ cls: "ion-version-meta" });
    meta.createSpan({ text: c.path, cls: "ion-version-num", attr: { title: c.path } });
    meta.createSpan({ text: new Date(c.mtime).toLocaleString(), cls: "ion-version-date" });
    if (c.deviceName) meta.createSpan({ text: `from ${c.deviceName}`, cls: "ion-version-sha" });

    const actions = header.createDiv({ cls: "ion-version-actions" });

    // ── Preview ──
    const previewBtn = actions.createEl("button", { text: "Preview", cls: "ion-btn" });
    const previewArea = row.createDiv({ cls: "ion-preview-area" });
    previewArea.hide();
    previewBtn.onclick = async () => {
      if (previewArea.style.display !== "none") {
        previewArea.hide();
        previewBtn.textContent = "Preview";
        return;
      }
      previewBtn.textContent = "Loading…";
      previewBtn.disabled = true;
      try {
        const text = await this._conflictText(c.id);
        previewArea.empty();
        const pre = previewArea.createEl("pre", { cls: "ion-preview-content" });
        pre.textContent = text;
        previewArea.show();
        previewBtn.textContent = "Hide";
      } catch (e) {
        previewArea.textContent = e instanceof Error ? e.message : String(e);
        previewArea.show();
        previewBtn.textContent = "Preview";
      }
      previewBtn.disabled = false;
    };

    // ── Restore (two-click arm — overwrites the current file) ──
    const restoreBtn = actions.createEl("button", { text: "Restore", cls: "ion-btn ion-btn-primary" });
    this._armed(restoreBtn, "Restore", "Confirm restore?", async () => {
      const resp = await this.plugin.xSync.restoreConflict(c.id);
      if (resp.ok) {
        new Notice(`Restored this version into ${c.path}`);
        row.remove();
      } else {
        new Notice(`Restore failed: ${resp.error ?? "unknown error"}`);
      }
    });

    // ── Dismiss (two-click arm — discards the losing content) ──
    const dismissBtn = actions.createEl("button", { text: "Dismiss", cls: "ion-btn" });
    this._armed(dismissBtn, "Dismiss", "Confirm dismiss?", async () => {
      const resp = await this.plugin.xSync.dismissConflict(c.id);
      if (resp.ok) {
        new Notice("Conflict dismissed");
        row.remove();
      } else {
        new Notice(`Dismiss failed: ${resp.error ?? "unknown error"}`);
      }
    });
  }

  /** Two-click confirmation: first click arms (5s), second click runs the action. */
  private _armed(btn: HTMLButtonElement, label: string, confirmLabel: string, run: () => Promise<void>): void {
    let armed = false;
    let timer: number | null = null;
    btn.onclick = async () => {
      if (!armed) {
        armed = true;
        btn.textContent = confirmLabel;
        btn.addClass("ion-btn-primary");
        timer = window.setTimeout(() => { armed = false; btn.textContent = label; btn.removeClass("ion-btn-primary"); }, 5000);
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      armed = false;
      btn.disabled = true;
      btn.textContent = "Working…";
      try {
        await run();
      } catch (e) {
        new Notice(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
        btn.disabled = false;
        btn.textContent = label;
      }
    };
  }

  /** Fetch a conflict's losing content and decrypt it if E2EE is active. */
  private async _conflictText(id: number): Promise<string> {
    const resp = await this.plugin.xSync.getConflictContent(id);
    if (!resp.found || !resp.content) throw new Error("Conflict content is no longer on the server.");
    if (resp.encrypted || isEncryptedBase64(resp.content)) {
      const key = await this.plugin.xSync.getE2eeKey();
      if (!key) {
        throw new Error(
          "This conflict is encrypted but E2EE is not enabled in your plugin settings. " +
          "Enable encryption and enter your vault key to preview it."
        );
      }
      const plainBuf = await decryptFromBase64(resp.content, this.plugin.getEncryptionPassword());
      return new TextDecoder().decode(plainBuf);
    }
    return Buffer.from(resp.content, "base64").toString("utf-8");
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
