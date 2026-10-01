import type http from "node:http";
import type { AddressInfo } from "node:net";
import type { ApiConfig } from "./config.js";
import { Vault } from "./vault.js";
import { createHttpServer } from "./http.js";

export interface Gateway {
  vault: Vault;
  server: http.Server;
  /** Start syncing and listening; resolves with the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createGateway(cfg: ApiConfig): Gateway {
  const vault = new Vault(cfg);
  const server = createHttpServer(cfg, vault);
  return {
    vault,
    server,
    listen() {
      vault.start();
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, cfg.host, () => resolve((server.address() as AddressInfo).port));
      });
    },
    close() {
      vault.stop();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
