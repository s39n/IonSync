import { createHash } from "node:crypto";

export interface ApiConfig {
  /** ws:// or wss:// URL of the IonSync sync server. */
  serverUrl: string;
  /** The sync server's shared password (same one the plugin uses). */
  password: string;
  /** Vault encryption password; null when the vault is not end-to-end encrypted. */
  e2eePassword: string | null;
  /** Force the E2EE format version for writes; null = follow what the vault uses. */
  e2eeVersion: number | null;
  /** Bearer token with full access. */
  token: string;
  /** Optional bearer token that may only read and search. */
  readToken: string | null;
  port: number;
  host: string;
  /** Trust CF-Connecting-IP / X-Forwarded-For for per-client rate limiting. */
  trustProxy: boolean;
  deviceId: string;
  deviceName: string;
  maxDeletesPerHour: number;
  maxNoteBytes: number;
  log: (line: string) => void;
}

export const MIN_TOKEN_LENGTH = 24;

/**
 * Build the config from environment variables. Returns `{ disabled }` (with the
 * reason) when the API is not configured — the process then idles instead of
 * exiting, so a compose stack with `restart: unless-stopped` does not loop.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig | { disabled: string } {
  const token = (env["IONSYNC_API_TOKEN"] ?? "").trim();
  if (!token) return { disabled: "IONSYNC_API_TOKEN is not set" };
  if (token.length < MIN_TOKEN_LENGTH) {
    return { disabled: `IONSYNC_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters` };
  }
  const password = env["IONSYNC_PASSWORD"] ?? "";
  if (!password) return { disabled: "IONSYNC_PASSWORD is not set" };

  const readToken = (env["IONSYNC_API_READ_TOKEN"] ?? "").trim();
  if (readToken && readToken.length < MIN_TOKEN_LENGTH) {
    return { disabled: `IONSYNC_API_READ_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters` };
  }
  const version = Number(env["IONSYNC_API_E2EE_VERSION"] ?? "");

  return {
    serverUrl: env["IONSYNC_API_SERVER_URL"] ?? "ws://127.0.0.1:3000",
    password,
    e2eePassword: env["IONSYNC_E2EE_PASSWORD"] || null,
    e2eeVersion: version === 2 || version === 3 ? version : null,
    token,
    readToken: readToken || null,
    port: Number(env["IONSYNC_API_PORT"] ?? 3002),
    host: env["IONSYNC_API_HOST"] ?? "0.0.0.0",
    trustProxy: env["IONSYNC_API_TRUST_PROXY"] === "1",
    deviceId: env["IONSYNC_API_DEVICE_ID"] ?? defaultDeviceId(password),
    deviceName: env["IONSYNC_API_DEVICE_NAME"] ?? "LLM API",
    maxDeletesPerHour: Number(env["IONSYNC_API_MAX_DELETES_PER_HOUR"] ?? 60),
    maxNoteBytes: Number(env["IONSYNC_API_MAX_NOTE_MB"] ?? 5) * 1024 * 1024,
    log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
  };
}

/**
 * A stable device ID needs no disk state: derive it from the server password,
 * so the gateway shows up as ONE device across restarts and redeploys.
 */
export function defaultDeviceId(password: string): string {
  return "llm-api-" + createHash("sha256").update(password + "\0llm-api").digest("hex").slice(0, 12);
}
