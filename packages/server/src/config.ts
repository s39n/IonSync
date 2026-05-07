import fs from "node:fs";
import path from "node:path";

export interface CleanupConfig {
  intervalSecs: number;
  versionsPerFile: number;
  keepDeletedFilesSecs: number;
}

export interface TlsConfig {
  key: string;
  cert: string;
}

export interface Config {
  password: string;
  port: number;
  host: string;
  tls?: TlsConfig;
  appDir: string;
  dataDir: string;
  cleanup: CleanupConfig;
  logs: { level: number };
  maxFileSizeMb: number; 
}

const DEFAULTS: Omit<Config, "password"> = {
  port: 3000,
  host: "0.0.0.0",
  appDir: process.cwd(),
  dataDir: "data",
  cleanup: { intervalSecs: 3600, versionsPerFile: 5, keepDeletedFilesSecs: 7 * 24 * 3600 },
  logs: { level: 3 },
  maxFileSizeMb: 50, 
};

export async function loadConfig(configPath?: string): Promise<Config> {
  const resolved = path.resolve(configPath ?? "config.js");
  if (!fs.existsSync(resolved)) {
    const examplePath = path.resolve(path.dirname(resolved), "config.example.js");
    const example = fs.existsSync(examplePath)
      ? "\n\nExample config:\n" + fs.readFileSync(examplePath, "utf8")
      : "";
    throw new Error(`Config file not found: ${resolved}${example}`);
  }
  const mod = (await import(resolved)) as Record<string, unknown>;
  const raw = (mod["default"] ?? mod) as Record<string, unknown>;
  return mergeConfig(raw);
}

export function mergeConfig(raw: Record<string, unknown>): Config {
  if (!raw["password"] || typeof raw["password"] !== "string") {
    throw new Error('Config must have a non-empty "password" string.');
  }

  const cleanup = (raw["cleanup"] as Partial<CleanupConfig> | undefined) ?? {};
  const logs = (raw["logs"] as { level?: number } | undefined) ?? {};

  const result: Config = {
    password: raw["password"],
    port: typeof raw["port"] === "number" ? raw["port"] : DEFAULTS.port,
    host: typeof raw["host"] === "string" ? raw["host"] : DEFAULTS.host,
    appDir: typeof raw["appDir"] === "string" ? raw["appDir"] : DEFAULTS.appDir,
    dataDir: typeof raw["dataDir"] === "string" ? raw["dataDir"] : DEFAULTS.dataDir,
    cleanup: {
      intervalSecs: cleanup.intervalSecs ?? DEFAULTS.cleanup.intervalSecs,
      versionsPerFile: cleanup.versionsPerFile ?? DEFAULTS.cleanup.versionsPerFile,
      keepDeletedFilesSecs: cleanup.keepDeletedFilesSecs ?? DEFAULTS.cleanup.keepDeletedFilesSecs,
    },
    logs: { level: logs.level ?? DEFAULTS.logs.level },
    maxFileSizeMb: process.env.MAX_FILE_SIZE_MB ? parseInt(process.env.MAX_FILE_SIZE_MB, 10) : (typeof raw["maxFileSizeMb"] === "number" ? raw["maxFileSizeMb"] : DEFAULTS.maxFileSizeMb),
  };

  if (raw["tls"] && typeof raw["tls"] === "object") {
    result.tls = raw["tls"] as TlsConfig;
  }

  return result;
}