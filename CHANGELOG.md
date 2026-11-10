# Changelog

Notable changes to IonSync. Plugin releases are numbered; server and API
changes ship continuously from `main` and are listed under the release they
landed before. Earlier history is in `git log`.

## Unreleased

## 2.0.13 — 2026-11-10

### Added
- **LLM API** (`packages/api`, optional `ionsync-api` service): token-protected
  REST API to search, list, read, create, edit, move and delete notes. Runs as a
  sync client, so the server stays zero-knowledge with E2EE. Tag, frontmatter and
  date filters; folder tree; outline and line-window reads; OpenAPI 3.1 spec.
- **Add a device by link or QR code.** The dashboard's Devices tab builds an
  `obsidian://ionsync-setup` link; the plugin validates it and asks for
  confirmation before pointing the vault at the server. The password is
  optional in the link and is never read back from the server.
- Prebuilt multi-arch server image on GHCR (`ghcr.io/s39n/ionsync`) and a
  pull-only `docker-compose.image.yml`.
- `IONSYNC_MAX_FILE_SIZE_MB` — configurable max file size in Docker; the
  WebSocket frame cap follows it.

### Fixed
- `docker compose up` with the default settings failed with "undefined volume
  ionsync_data"; the volume is now declared.
- Plugin writes large files in chunks on mobile, avoiding Android out-of-memory
  crashes.

### Docs
- README: correct dashboard port (3001), current conflict model, community-store
  install steps, full env-var table, and a remote-access guide.

## 2.0.12 — 2026-09-27

Faster, lighter mobile sync: quicker resume, pipelined handshake, the open note
syncs first, byte-level downloads. A stalled session restarts on resume.

## 2.0.11 — 2026-09-27

Lossless mobile background sync: edits made just before the app is backgrounded
are flushed through an authenticated beacon endpoint and confirmed on reconnect.
Replays are exactly-once and can never resurrect, duplicate or downgrade a note.

## Earlier in 2026-09 (through 2.0.10)

Reproducible plugin builds with attested releases; plugin published from the
standalone `s39n/ion-sync` repository; declarative settings; security audit
fixes (signed auto-updates, CSRF protection, per-install E2EE salt, admin
session tokens, sealed TOTP secret). See `SECURITY.md`.
