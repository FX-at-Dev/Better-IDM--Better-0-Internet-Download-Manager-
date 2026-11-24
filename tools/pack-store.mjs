// Packs the extension for the stores: release/store/prism-chrome-edge-<v>.zip (Chrome Web Store and
// Microsoft Edge Add-ons take the same MV3 zip) and release/store/prism-firefox-<v>.zip (addons.mozilla.org).
// Run `npm run pack:store`, then follow store/README.md.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.join(root, "release", "store");
fs.mkdirSync(out, { recursive: true });

// Store copies: the Chrome Web Store (and, to be safe, Edge Add-ons) don't accept YouTube downloading,
// so their build hides the video button on YouTube. Firefox's add-on store allows it.
const staging = path.join(out, "staging");
fs.rmSync(staging, { recursive: true, force: true });
function stage(from, name, storeBuild) {
  const dir = path.join(staging, name);
  fs.cpSync(from, dir, { recursive: true });
  if (storeBuild)
    for (const f of ["background.js", "content.js"]) {
      const p = path.join(dir, f);
      const src = fs.readFileSync(p, "utf8");
      if (!src.includes("const STORE_BUILD = false;")) throw new Error(`STORE_BUILD flag missing in ${f}`);
      fs.writeFileSync(p, src.replace("const STORE_BUILD = false;", "const STORE_BUILD = true;"));
    }
  return dir;
}

for (const [name, dir] of [
  [`prism-chrome-edge-${pkg.version}.zip`, stage(path.join(root, "extension", "build", "chrome"), "chrome", true)],
  [`prism-firefox-${pkg.version}.zip`, stage(path.join(root, "extension", "build", "firefox"), "firefox", false)],
]) {
  const file = path.join(out, name);
  fs.rmSync(file, { force: true });
  // manifest.json must sit at the root of the zip
  // Windows' bsdtar writes real zips; Git's GNU tar (often first on PATH) can't
  const winTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const tar = process.platform === "win32" && fs.existsSync(winTar) ? winTar : "bsdtar";
  const r = spawnSync(tar, ["-a", "-c", "-f", file, ...fs.readdirSync(dir)], { cwd: dir });
  if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
  console.log("packed", path.relative(root, file), `${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
fs.rmSync(staging, { recursive: true, force: true });
