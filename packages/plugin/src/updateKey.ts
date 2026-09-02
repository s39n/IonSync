/**
 * Pinned ed25519 public key (raw 32-byte, hex) for verifying plugin auto-update
 * bundles. The matching PRIVATE key is a build-time secret (IONSYNC_SIGN_KEY)
 * that never reaches the runtime server, so a rogue or MITM server — even over
 * plain ws:// — cannot forge an update the plugin will apply (SECURITY.md #4).
 *
 * Rotating the key means signing the build with a new private key AND shipping a
 * plugin that pins the new public key here.
 */
export const PLUGIN_UPDATE_PUBKEY =
  "37c2050aa58b69f1e8d2275240aea0e112d2d822b621bf8a1235b4b6d3d8e930";
