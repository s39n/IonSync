/**
 * Handles `version_check` from the client.
 *
 * If the server has a newer plugin build, it responds with the content of
 * main.js, styles.css, and manifest.json from the client/ directory so the
 * plugin can hot-reload itself — preserving the v1 auto-update feature.
 */
import type { VersionCheckMsg } from "@ionsync/protocol";
import { APP_PING_CAP, BG_RESEND_CAP, PIPELINED_AUTH_CAP } from "@ionsync/protocol";
import type { SyncContext } from "../../context.js";
import type { SyncPeer } from "../peer.js";
import fs from "node:fs";
import path from "node:path";

interface BuildInfo {
  version: string;
  build: string;
  /** base64 ed25519 signature of main.js, written by the signed build. */
  sig?: string;
  /** base64 ed25519 signature over every allowlisted update file. */
  filesSig?: string;
}

// Cached build info loaded once at startup
/** Log the "unsigned bundle, auto-update off" notice once per process. */
let warnedUnsigned = false;

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
 *  (e.g. atomic `file_rename`, binary content frames) without a version-number
 *  handshake. */
const SERVER_CAPS = ["file_rename", "binary_frames", BG_RESEND_CAP, APP_PING_CAP, PIPELINED_AUTH_CAP];

export function handleVersionCheck(
  ctx: SyncContext,
  peer: SyncPeer,
  msg: VersionCheckMsg
): void {
  // Record what the client supports so peer.send can pick binary vs JSON framing
  // per-peer. Absent on old clients → stays [] → legacy base64-in-JSON.
  peer.caps = msg.caps ?? [];

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

  // An UNSIGNED bundle is never offered. Every current plugin pins the update
  // public key and refuses a bundle without a valid signature (SECURITY.md #4),
  // so offering one cannot update anybody — it only shows the user a "Blocked an
  // unsigned plugin update" warning on every connect. That is the normal state
  // for anyone who builds the image themselves or runs the public one (only a
  // build given IONSYNC_SIGN_KEY is signed): their devices simply keep the
  // plugin version installed from the community store. A signed build is
  // unaffected and auto-updates exactly as before.
  if (!serverBuild.sig) {
    if (!warnedUnsigned) {
      warnedUnsigned = true;
      const line = `[${new Date().toISOString()}] [version_check] plugin bundle is unsigned - auto-update is off; devices keep their installed plugin version`;
      if (ctx.config.logs.level >= 3) {
        console.log(line);
        ctx.logBuffer.push(line);
        if (ctx.logBuffer.length > 200) ctx.logBuffer.shift();
      }
    }
    peer.send({ type: "version_check_response", needsUpdate: false, caps: SERVER_CAPS });
    return;
  }

  // Read and encode plugin files.
  //
  // MIGRATION SHIM for clients built before 2026-07-06: their updatePlugin
  // wrote each file to "../<name>" relative to the plugin dir — i.e. into
  // .obsidian/plugins/ — so no update could ever apply (endless reload loop).
  // Sending each file a second time under "ion-sync/<name>" makes those
  // clients resolve "../ion-sync/<name>" to the CORRECT plugin folder, so
  // one update cycle heals them. Fixed clients skip any name containing a
  // slash. Remove the shim once every device is on a post-fix build.
  const files: Record<string, string> = {};
  for (const filename of PLUGIN_FILES) {
    const fp = path.join(ctx.clientDir, filename);
    if (fs.existsSync(fp)) {
      const b64 = fs.readFileSync(fp).toString("base64");
      files[filename] = b64;
      files[`ion-sync/${filename}`] = b64;
    }
  }

  peer.send({ type: "version_check_response", needsUpdate: true, files, ...(serverBuild.sig ? { signature: serverBuild.sig } : {}), ...(serverBuild.filesSig ? { filesSignature: serverBuild.filesSig } : {}), caps: SERVER_CAPS });
}
