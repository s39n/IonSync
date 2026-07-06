/**
 * Handles `version_check` from the client.
 *
 * If the server has a newer plugin build, it responds with the content of
 * main.js, styles.css, and manifest.json from the client/ directory so the
 * plugin can hot-reload itself — preserving the v1 auto-update feature.
 */
import type { VersionCheckMsg } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import fs from "node:fs";
import path from "node:path";

interface BuildInfo {
  version: string;
  build: string;
}

// Cached build info loaded once at startup
let cachedBuildInfo: BuildInfo | null = null;
let cachedClientDir = "";

function getBuildInfo(clientDir: string): BuildInfo | null {
  if (cachedClientDir !== clientDir) {
    cachedBuildInfo = null;
    cachedClientDir = clientDir;
  }
  if (cachedBuildInfo) return cachedBuildInfo;

  const infoPath = path.join(clientDir, "build_info.json");
  if (!fs.existsSync(infoPath)) return null;

  try {
    cachedBuildInfo = JSON.parse(fs.readFileSync(infoPath, "utf8")) as BuildInfo;
    return cachedBuildInfo;
  } catch {
    return null;
  }
}

const PLUGIN_FILES = ["main.js", "styles.css", "manifest.json"] as const;

/** Capability tokens this server understands. Lets new plugins feature-detect
 *  (e.g. atomic `file_rename`) without a version-number handshake. */
const SERVER_CAPS = ["file_rename"];

export function handleVersionCheck(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: VersionCheckMsg
): void {
  const serverBuild = getBuildInfo(ctx.clientDir);

  if (!serverBuild) {
    // No build info available — treat as up-to-date
    peer.send({ type: "version_check_response", needsUpdate: false, caps: SERVER_CAPS });
    return;
  }

  // Normalize both sides to strings: older build_info.json files stored the
  // build stamp as a number while the plugin sends a string — a strict
  // comparison across types would report "update available" on every connect
  // and put the plugin in a reload loop.
  const needsUpdate =
    msg.version !== serverBuild.version || String(msg.build) !== String(serverBuild.build);

  if (!needsUpdate) {
    peer.send({ type: "version_check_response", needsUpdate: false, caps: SERVER_CAPS });
    return;
  }

  // Read and encode plugin files
  const files: Record<string, string> = {};
  for (const filename of PLUGIN_FILES) {
    const fp = path.join(ctx.clientDir, filename);
    if (fs.existsSync(fp)) {
      files[filename] = fs.readFileSync(fp).toString("base64");
    }
  }

  peer.send({ type: "version_check_response", needsUpdate: true, files, caps: SERVER_CAPS });
}
