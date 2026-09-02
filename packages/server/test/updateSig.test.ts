import { test } from "node:test";
import assert from "node:assert/strict";
import { signPluginBundle, verifyPluginBundle } from "@ionsync/protocol";

// Throwaway test keypair (NOT the production signing key).
const TEST_PUB = "5018246e911354f1d0439133cee043dd4ca8bde6271981d0e72ad4d5dab520ce";
const TEST_PRIV = "826be08798a3dc7fc4c7cb033400d416e82fb637177f839ffc3ec26e56e6f459";
const OTHER_PUB = "37c2050aa58b69f1e8d2275240aea0e112d2d822b621bf8a1235b4b6d3d8e930";

test("sign/verify round-trips a bundle", () => {
  const bundle = new TextEncoder().encode("console.log('ion-sync plugin bundle');");
  const sig = signPluginBundle(bundle, TEST_PRIV);
  assert.equal(verifyPluginBundle(bundle, sig, TEST_PUB), true);
});

test("rejects a tampered bundle (the RCE case)", () => {
  const bundle = new TextEncoder().encode("good code");
  const sig = signPluginBundle(bundle, TEST_PRIV);
  const tampered = new TextEncoder().encode("evil code injected by a rogue server");
  assert.equal(verifyPluginBundle(tampered, sig, TEST_PUB), false);
});

test("rejects a signature made with the wrong key", () => {
  const bundle = new TextEncoder().encode("code");
  const sig = signPluginBundle(bundle, TEST_PRIV);
  assert.equal(verifyPluginBundle(bundle, sig, OTHER_PUB), false);
});

test("fails closed on a missing or malformed signature", () => {
  const bundle = new TextEncoder().encode("code");
  assert.equal(verifyPluginBundle(bundle, undefined, TEST_PUB), false);
  assert.equal(verifyPluginBundle(bundle, "", TEST_PUB), false);
  assert.equal(verifyPluginBundle(bundle, "!!!not-base64!!!", TEST_PUB), false);
});
