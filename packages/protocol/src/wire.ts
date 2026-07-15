// ─── Binary-frame wire codec ────────────────────────────────────────────────
//
// Content-bearing messages (`file_data` uploads, `file_push`) can travel as a
// single WebSocket **binary** frame instead of base64-inside-JSON. The envelope
// is:
//
//   [4-byte big-endian header length][UTF-8 JSON header][raw content bytes]
//
// The JSON header is the ordinary message object with its `contentBytes`
// stripped and `content` blanked — every field the routing/conflict logic reads
// (path, sha1, mtime, baseSha1, seq, …) is still there. The file bytes ride
// after the header with no base64 (+33% size) and no per-byte string building.
//
// Control messages (auth, sync, file_event_result, sync_done, …) are unchanged
// JSON text frames. Binary framing is used only when BOTH peers advertise the
// `"binary_frames"` capability; otherwise `encodeFrame` falls back to today's
// base64-in-JSON, so a new peer talking to an old one is wire-compatible.
//
// Receive side distinguishes the two by frame type: a text frame arrives as a
// string, a binary frame as bytes. No magic byte is needed.

import type { ClientMsg, ServerMsg } from "./index.js";

export const BINARY_FRAMES_CAP = "binary_frames";

/** Anything the codec might carry as raw bytes. Kept structural so both the
 *  client (Uint8Array) and server (Buffer, a Uint8Array subclass) satisfy it. */
interface WireMessage {
  type: string;
  mode?: string;
  content?: string;
  /** Raw file bytes. Never JSON-serialized — the codec moves it into the
   *  binary frame's trailing segment (or base64s it into `content` on the
   *  JSON fallback path). */
  contentBytes?: Uint8Array;
  [k: string]: unknown;
}

const HEADER_PREFIX_LEN = 4;
const B64_CHUNK = 0x8000; // 32 KiB — under the engine's argument-count ceiling

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + B64_CHUNK) as unknown as number[]
    );
  }
  return btoa(binary);
}

/**
 * True when a message is eligible for a binary frame: it carries raw bytes and
 * is one of the hot content paths. Download responses, plugin-update payloads,
 * etc. deliberately stay on JSON.
 */
export function canBinaryFrame(msg: WireMessage): boolean {
  if (!msg.contentBytes) return false;
  if (msg.type === "file_push") return true;
  if (msg.type === "file_data" && msg.mode === "apply") return true;
  return false;
}

/**
 * Encode a message for the wire. Returns a Uint8Array (binary frame) when
 * `binaryEnabled` and the message qualifies, otherwise a JSON string. If bytes
 * are present but binary is not enabled, they are base64-encoded into `content`
 * so the result is identical to a legacy sender.
 */
export function encodeFrame(
  msg: ClientMsg | ServerMsg,
  binaryEnabled: boolean
): string | Uint8Array {
  const m = msg as WireMessage;

  if (binaryEnabled && canBinaryFrame(m)) {
    const bytes = m.contentBytes!;
    const header: WireMessage = { ...m, content: "" };
    delete header.contentBytes;
    const headerJson = new TextEncoder().encode(JSON.stringify(header));

    const out = new Uint8Array(HEADER_PREFIX_LEN + headerJson.length + bytes.length);
    new DataView(out.buffer).setUint32(0, headerJson.length, false); // big-endian
    out.set(headerJson, HEADER_PREFIX_LEN);
    out.set(bytes, HEADER_PREFIX_LEN + headerJson.length);
    return out;
  }

  if (m.contentBytes) {
    const clone: WireMessage = { ...m, content: bytesToBase64(m.contentBytes) };
    delete clone.contentBytes;
    return JSON.stringify(clone);
  }

  return JSON.stringify(msg);
}

/**
 * Decode an incoming frame. A string is parsed as JSON (control message or
 * legacy base64 content). A Uint8Array is an envelope: the JSON header is
 * parsed and the trailing bytes are attached as `contentBytes` (a subarray view
 * — no copy). Callers read `contentBytes` when present, else `content`.
 */
export function decodeFrame(data: string | Uint8Array): ClientMsg | ServerMsg {
  if (typeof data === "string") {
    return JSON.parse(data) as ClientMsg | ServerMsg;
  }

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLen = dv.getUint32(0, false);
  const headerEnd = HEADER_PREFIX_LEN + headerLen;
  const headerJson = new TextDecoder().decode(data.subarray(HEADER_PREFIX_LEN, headerEnd));
  const msg = JSON.parse(headerJson) as WireMessage;
  msg.contentBytes = data.subarray(headerEnd);
  return msg as unknown as ClientMsg | ServerMsg;
}
