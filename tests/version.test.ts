import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer, parseVersion, versionFromTagUrl } from "../src/main/version.js";

test("isNewer compares major, minor and patch as numbers", () => {
  assert.equal(isNewer("1.1.4", "1.1.3"), true);
  assert.equal(isNewer("v1.2.0", "1.1.9"), true);
  assert.equal(isNewer("1.10.0", "1.9.0"), true);
  assert.equal(isNewer("2.0.0", "1.99.99"), true);
  assert.equal(isNewer("1.1.3", "1.1.3"), false);
  assert.equal(isNewer("1.1.2", "1.1.3"), false);
  assert.equal(isNewer("garbage", "1.1.3"), false);
  assert.deepEqual(parseVersion("v1.2.3-beta.1"), [1, 2, 3]);
});

test("versionFromTagUrl reads the release a /releases/latest redirect points to", () => {
  const base = "https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/tag/";
  assert.equal(versionFromTagUrl(base + "v1.1.4"), "1.1.4");
  assert.equal(versionFromTagUrl(base + "1.2.0"), "1.2.0");
  assert.equal(versionFromTagUrl("https://github.com/x/y/releases"), null);
  assert.equal(versionFromTagUrl(base + "nightly"), null);
});
