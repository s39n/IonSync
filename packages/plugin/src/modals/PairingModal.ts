import { Modal, Setting } from "obsidian";
import type { IonSyncPlugin } from "../main.js";
import { pairingAddress, type PairingRequest } from "../pairing.js";

/**
 * Confirmation step for a setup link (see pairing.ts). A link is untrusted, and
 * accepting one uploads this vault to the server it names — so the address is
 * shown in full and nothing changes until the user presses "Connect".
 */
export class PairingModal extends Modal {
  constructor(private plugin: IonSyncPlugin, private request: PairingRequest) {
    super(plugin.app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    const { plugin, request } = this;
    contentEl.empty();

    this.setTitle("Connect to sync server");

    contentEl.createEl("p", { text: "A setup link wants to connect this vault to:" });
    contentEl.createEl("p").createEl("strong", { text: pairingAddress(request) });

    const current = plugin.settings.host;
    if (current && current !== request.host) {
      contentEl.createEl("p", {
        text: `This replaces the server this vault uses now (${current}).`,
      });
    }

    contentEl.createEl("p", {
      text: request.password
        ? "The link includes the server password."
        : "The link has no password. Enter the server password in the plugin settings afterwards.",
    });

    contentEl.createEl("p", {
      cls: "mod-warning",
      text: "Only continue if this is your own server. Notes in this vault are uploaded to it.",
    });

    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Connect").setCta().onClick(() => {
          this.close();
          void plugin.applyPairing(request);
        })
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
