import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  categoryOf,
  filenameFromDisposition,
  hostMatches,
  looksDownloadable,
  pickFilename,
  sanitize,
  uniquePath,
} from "../src/main/naming.js";
import { algoForDigest, normalizeDigest } from "../src/main/checksum.js";
import { formatSelector } from "../src/main/media.js";
import { sanitizeSettings, defaultSettings } from "../src/main/store.js";

test("Content-Disposition parsing", () => {
  assert.equal(filenameFromDisposition(`attachment; filename="a \\"b\\".zip"`), `a "b".zip`);
  assert.equal(filenameFromDisposition(`attachment; filename=plain.iso`), "plain.iso");
  assert.equal(filenameFromDisposition(`attachment; filename="x.zip"; filename*=UTF-8''%E2%82%AC.zip`), "€.zip");
  assert.equal(filenameFromDisposition(undefined), null);
});

test("sanitize handles reserved names, illegal characters and length", () => {
  assert.equal(sanitize("CON.txt"), "_CON.txt");
  assert.equal(sanitize("a<b>c:d?.pdf"), "a_b_c_d_.pdf");
  assert.equal(sanitize("trailing dots..."), "trailing dots");
  assert.equal(sanitize("   "), "download");
  const long = sanitize("x".repeat(400) + ".mkv");
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith(".mkv"));
});

test("pickFilename falls back to the URL and adds an extension from MIME", () => {
  assert.equal(pickFilename({ url: "https://h/dl/My%20File.tar.gz?x=1" }), "My File.tar.gz");
  assert.equal(pickFilename({ url: "https://h/download", contentType: "application/pdf" }), "download.pdf");
  assert.equal(pickFilename({ url: "https://h/a", disposition: 'attachment; filename="../../evil.exe"' }), "evil.exe");
});

test("uniquePath auto-renames collisions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-n-"));
  fs.writeFileSync(path.join(dir, "f.zip"), "");
  fs.writeFileSync(path.join(dir, "f (1).zip.lanes-part"), "");
  assert.equal(path.basename(uniquePath(dir, "f.zip")), "f (2).zip");
  assert.equal(path.basename(uniquePath(dir, "g.zip", new Set([path.join(dir, "g.zip").toLowerCase()]))), "g (1).zip");
  fs.rmSync(dir, { recursive: true });
});

test("categories and clipboard detection", () => {
  assert.equal(categoryOf("movie.MKV"), "video");
  assert.equal(categoryOf("setup.exe"), "programs");
  assert.equal(categoryOf("x.torrent"), "torrents");
  assert.equal(categoryOf("readme"), "other");
  assert.ok(looksDownloadable("https://example.com/file.zip"));
  assert.ok(looksDownloadable("magnet:?xt=urn:btih:abc"));
  assert.ok(!looksDownloadable("https://example.com/page"));
  assert.ok(!looksDownloadable("hello world"));
});

test("site rules match host globs", () => {
  assert.ok(hostMatches("*.github.com", "https://objects.github.com/x"));
  assert.ok(hostMatches("*.github.com", "https://github.com/x"));
  assert.ok(hostMatches("example.org", "https://cdn.example.org/x"));
  assert.ok(!hostMatches("example.org", "https://notexample.org/x"));
  assert.ok(hostMatches("cdn*.site.io", "https://cdn3.site.io/"));
});

test("checksum helpers", () => {
  assert.equal(algoForDigest("d41d8cd98f00b204e9800998ecf8427e"), "md5");
  assert.equal(algoForDigest("A".repeat(64)), "sha256");
  assert.equal(algoForDigest("zz"), null);
  assert.equal(normalizeDigest(" SHA256: AB CD "), "abcd");
});

test("yt-dlp format selectors avoid HLS/DASH", () => {
  assert.match(formatSelector("720"), /height<=720/);
  assert.match(formatSelector("best"), /protocol!\*=m3u8/);
  assert.match(formatSelector("audio"), /^ba/);
});

test("settings are clamped and validated", () => {
  const s = sanitizeSettings(defaultSettings(), { maxActive: 999, accent: "red", theme: "neon" as any, queues: [] });
  assert.equal(s.maxActive, 32);
  assert.equal(s.accent, defaultSettings().accent);
  assert.equal(s.theme, "glass");
  assert.equal(s.queues[0].id, "main");
});
