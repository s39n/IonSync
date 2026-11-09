/**
 * Setup links: `obsidian://ionsync-setup?host=…&port=…&tls=1[&pw=…]`.
 *
 * The server dashboard renders one as a link and a QR code so a new device can
 * be pointed at the server without typing host, port and password by hand.
 *
 * A setup link is UNTRUSTED input — anything can hand Obsidian such a URL. It
 * is therefore only ever parsed here and shown in a confirmation dialog
 * (PairingModal); nothing is applied until the user confirms the server
 * address, because the vault is uploaded to whichever server it names.
 *
 * Pure module (no Obsidian imports) so the server test suite can exercise it.
 */

/** The `obsidian://<action>` this plugin registers. */
export const PAIRING_ACTION = "ionsync-setup";

export interface PairingRequest {
  host: string;
  /** 0 = scheme default (80 for ws, 443 for wss), same as the settings field. */
  port: number;
  tls: boolean;
  /** Sync password, when the link carries one. Never an encryption password. */
  password?: string;
}

export type PairingParseResult =
  | { ok: true; request: PairingRequest }
  | { ok: false; error: string };

// A DNS name / IPv4 address, or a bracketed IPv6 literal. Deliberately strict:
// no scheme, path, port, userinfo or whitespace can ride along in the host.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const IPV6_RE = /^\[[0-9a-f:.]{2,45}\]$/i;

const MAX_PASSWORD_LENGTH = 512;

export function isValidPairingHost(host: string): boolean {
  return HOSTNAME_RE.test(host) || IPV6_RE.test(host);
}

/** Validate the query parameters of a setup link. */
export function parsePairingParams(
  params: Record<string, string | undefined>
): PairingParseResult {
  const host = (params["host"] ?? "").trim();
  if (!host) return { ok: false, error: "no server address" };
  if (!isValidPairingHost(host)) return { ok: false, error: "invalid server address" };

  let port = 0;
  const rawPort = (params["port"] ?? "").trim();
  if (rawPort) {
    if (!/^\d{1,5}$/.test(rawPort)) return { ok: false, error: "invalid port" };
    port = Number(rawPort);
    if (port < 1 || port > 65535) return { ok: false, error: "invalid port" };
  }

  const rawTls = (params["tls"] ?? "").trim().toLowerCase();
  if (rawTls && !["0", "1", "true", "false"].includes(rawTls)) {
    return { ok: false, error: "invalid TLS flag" };
  }
  const tls = rawTls === "1" || rawTls === "true";

  const request: PairingRequest = { host, port, tls };
  const password = params["pw"];
  if (password) {
    if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, error: "password too long" };
    request.password = password;
  }
  return { ok: true, request };
}

/** The address a request points at, as shown to the user before confirming. */
export function pairingAddress(req: PairingRequest): string {
  const scheme = req.tls ? "wss" : "ws";
  return req.port ? `${scheme}://${req.host}:${req.port}` : `${scheme}://${req.host}`;
}

/** Build a setup link. The dashboard builds the same shape in plain JS. */
export function buildPairingUri(req: PairingRequest): string {
  const q = [`host=${encodeURIComponent(req.host)}`];
  if (req.port) q.push(`port=${req.port}`);
  q.push(`tls=${req.tls ? 1 : 0}`);
  if (req.password) q.push(`pw=${encodeURIComponent(req.password)}`);
  return `obsidian://${PAIRING_ACTION}?${q.join("&")}`;
}
