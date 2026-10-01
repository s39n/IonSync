import { loadConfig } from "./config.js";
import { createGateway } from "./gateway.js";

const cfg = loadConfig();

if ("disabled" in cfg) {
  // Stay up but idle: exiting would make a `restart: unless-stopped` container
  // loop forever on a stack that simply hasn't enabled the API.
  console.log(`[ionsync-api] disabled: ${cfg.disabled}. Set it and restart to enable the LLM API.`);
  setInterval(() => undefined, 1 << 30);
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
} else {
  const gateway = createGateway(cfg);
  const port = await gateway.listen();
  cfg.log(`[ionsync-api] listening on ${cfg.host}:${port}, syncing from ${cfg.serverUrl} as device ${cfg.deviceId}` +
    `${cfg.e2eePassword ? " (E2EE on)" : ""}${cfg.readToken ? " (+read-only token)" : ""}`);

  const shutdown = (): void => {
    void gateway.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
