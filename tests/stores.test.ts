import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { externalKeys, readStoreIds, storeLinks } from "../src/main/stores.js";
import { welcomePage } from "../src/main/welcome.js";

const CHROME = "abcdefghijklmnopabcdefghijklmnop";
const EDGE = "ponmlkjihgfedcbaponmlkjihgfedcba";

function pkgWith(stores: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-stores-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", lanes: { extensionStores: stores } }));
  return dir;
}

test("unpublished: no store ids, no registry keys, manual setup page", () => {
  const ids = readStoreIds(pkgWith({ chrome: "", edge: "", firefox: "" }));
  assert.deepEqual(ids, { chrome: undefined, edge: undefined, firefox: undefined });
  assert.deepEqual(externalKeys(ids), []);
  const html = welcomePage({ version: "1", chromePath: "C:\\p", firefoxPath: "C:\\f", stores: storeLinks(ids) });
  assert.match(html, /const STORES = \{\}/);
});

test("malformed ids are ignored rather than written to the registry", () => {
  const ids = readStoreIds(pkgWith({ chrome: "not-an-id", edge: "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", firefox: "bad slug!" }));
  assert.deepEqual(externalKeys(ids), []);
});

test("published: browsers are offered the store extension, and the page gets one-click links", () => {
  const ids = readStoreIds(pkgWith({ chrome: CHROME, edge: EDGE, firefox: "lanes-download-manager" }));
  assert.deepEqual(externalKeys(ids), [
    { key: `Software\\Google\\Chrome\\Extensions\\${CHROME}`, url: "https://clients2.google.com/service/update2/crx" },
    { key: `Software\\BraveSoftware\\Brave-Browser\\Extensions\\${CHROME}`, url: "https://clients2.google.com/service/update2/crx" },
    { key: `Software\\Microsoft\\Edge\\Extensions\\${EDGE}`, url: "https://edge.microsoft.com/extensionwebstorebase/v1/crx" },
  ]);
  const links = storeLinks(ids);
  assert.equal(links.chrome, `https://chromewebstore.google.com/detail/${CHROME}`);
  assert.equal(links.edge, `https://microsoftedge.microsoft.com/addons/detail/${EDGE}`);
  assert.equal(links.firefox, "https://addons.mozilla.org/firefox/addon/lanes-download-manager/");
  const html = welcomePage({ version: "1", chromePath: "C:\\p", firefoxPath: "C:\\f", stores: links });
  assert.ok(html.includes(links.edge!));
});

test("the setup page escapes paths and can't be broken out of", () => {
  const html = welcomePage({ version: "<b>", chromePath: `C:\\a"<script>alert(1)</script>`, firefoxPath: "x", stores: { chrome: "https://x/</script><script>alert(1)//" } });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("</script><script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("macOS: store extension offered through External Extensions files, only for installed browsers", async () => {
  const { externalFiles, registerExternalExtensions } = await import("../src/main/stores.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-mac-"));
  const files = externalFiles({ chrome: CHROME, edge: EDGE }, home);
  assert.equal(files.length, 3);
  assert.ok(files[0].file.endsWith(path.join("Google", "Chrome", "External Extensions", `${CHROME}.json`)));
  if (process.platform === "darwin") {
    fs.mkdirSync(path.join(home, "Library", "Application Support", "Google", "Chrome"), { recursive: true }); // only Chrome "installed"
    registerExternalExtensions({ chrome: CHROME, edge: EDGE }, home);
    assert.deepEqual(JSON.parse(fs.readFileSync(files[0].file, "utf8")), { external_update_url: "https://clients2.google.com/service/update2/crx" });
    assert.ok(!fs.existsSync(files[2].file), "Edge isn't installed, so nothing is written for it");
  }
});
