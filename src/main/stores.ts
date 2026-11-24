// One-click extension install, the way IDM does it — active once the extension is published.
//
// Put the store IDs in package.json → "prism.extensionStores" and rebuild. Prism then:
//  1. registers the extension with every installed Chromium browser (HKCU\…\Extensions\<id>),
//     so the browser shows "New extension added — Enable?" next time it starts;
//  2. turns the setup page into a single "Add to <browser>" button linking to the store.
// Until then both are no-ops and the setup page shows the manual (drag and drop) steps.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StoreLinks } from "./welcome.js";

export interface StoreIds {
  chrome?: string; // Chrome Web Store id (also used for Brave)
  edge?: string; // Microsoft Edge Add-ons id
  firefox?: string; // addons.mozilla.org slug, e.g. "prism-download-manager"
}

const ID = /^[a-p]{32}$/; // Chromium extension ids are 32 letters a–p

export function readStoreIds(appRoot: string): StoreIds {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
    const s = pkg?.prism?.extensionStores ?? {};
    return {
      chrome: ID.test(s.chrome ?? "") ? s.chrome : undefined,
      edge: ID.test(s.edge ?? "") ? s.edge : undefined,
      firefox: /^[\w-]{2,80}$/.test(s.firefox ?? "") ? s.firefox : undefined,
    };
  } catch {
    return {};
  }
}

export function storeLinks(ids: StoreIds): StoreLinks {
  return {
    chrome: ids.chrome ? `https://chromewebstore.google.com/detail/${ids.chrome}` : undefined,
    edge: ids.edge ? `https://microsoftedge.microsoft.com/addons/detail/${ids.edge}` : undefined,
    firefox: ids.firefox ? `https://addons.mozilla.org/firefox/addon/${ids.firefox}/` : undefined,
  };
}

const CHROME_UPDATE = "https://clients2.google.com/service/update2/crx";
const EDGE_UPDATE = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";

/** Registry keys (under HKCU) that make each browser offer the store extension. */
export function externalKeys(ids: StoreIds): { key: string; url: string }[] {
  const out: { key: string; url: string }[] = [];
  if (ids.chrome) {
    out.push({ key: `Software\\Google\\Chrome\\Extensions\\${ids.chrome}`, url: CHROME_UPDATE });
    out.push({ key: `Software\\BraveSoftware\\Brave-Browser\\Extensions\\${ids.chrome}`, url: CHROME_UPDATE });
  }
  if (ids.edge) out.push({ key: `Software\\Microsoft\\Edge\\Extensions\\${ids.edge}`, url: EDGE_UPDATE });
  return out;
}

/** macOS: per-user "External Extensions/<id>.json" files instead of registry keys. */
export function externalFiles(ids: StoreIds, home: string): { file: string; url: string }[] {
  const support = path.join(home, "Library", "Application Support");
  const out: { file: string; url: string }[] = [];
  if (ids.chrome) {
    out.push({ file: path.join(support, "Google", "Chrome", "External Extensions", `${ids.chrome}.json`), url: CHROME_UPDATE });
    out.push({ file: path.join(support, "BraveSoftware", "Brave-Browser", "External Extensions", `${ids.chrome}.json`), url: CHROME_UPDATE });
  }
  if (ids.edge) out.push({ file: path.join(support, "Microsoft Edge", "External Extensions", `${ids.edge}.json`), url: EDGE_UPDATE });
  return out;
}

/**
 * Per user, no admin needed, safe to run on every start. Windows: registry; macOS: files.
 * (Linux browsers only read this from system folders, which need root — there the setup page's store button is used.)
 */
export function registerExternalExtensions(ids: StoreIds, home = os.homedir()): void {
  if (process.platform === "win32") {
    for (const { key, url } of externalKeys(ids))
      spawn("reg", ["add", `HKCU\\${key}`, "/v", "update_url", "/t", "REG_SZ", "/d", url, "/f"], { windowsHide: true }).on("error", () => {});
  } else if (process.platform === "darwin") {
    for (const { file, url } of externalFiles(ids, home)) {
      // only for browsers that are installed (their profile folder exists)
      if (!fs.existsSync(path.dirname(path.dirname(file)))) continue;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ external_update_url: url }));
      } catch {}
    }
  }
}
