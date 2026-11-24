import fs from "node:fs";
import path from "node:path";
import type { Category } from "../shared/types.js";

const EXT: Record<Exclude<Category, "torrents" | "other">, string[]> = {
  video: ["mp4", "mkv", "webm", "avi", "mov", "wmv", "flv", "m4v", "mpg", "mpeg", "3gp", "3g2", "ts", "m2ts", "mts", "vob", "ogv", "rm", "rmvb", "asf", "divx", "f4v"],
  audio: ["mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus", "wma", "alac", "aiff", "aif", "ape", "amr", "mid", "midi", "mka", "weba", "m4b"],
  documents: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "odt", "ods", "odp", "epub", "mobi", "azw3", "csv", "md", "djvu", "xps", "pages", "numbers", "key", "one"],
  archives: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "tgz", "tbz2", "txz", "lz", "lzma", "z", "arj", "zipx", "iso", "img", "dmg", "cab", "001"],
  programs: ["exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "apk", "xapk", "deb", "rpm", "appimage", "pkg", "bat", "cmd", "jar", "msu", "vsix"],
  images: ["jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "svg", "tif", "tiff", "heic", "heif", "avif", "ico", "raw", "psd", "cr2", "cr3", "nef", "arw", "dng"],
};

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-7z-compressed": "7z",
  "application/x-rar-compressed": "rar",
  "application/vnd.rar": "rar",
  "application/gzip": "gz",
  "application/x-msdownload": "exe",
  "application/x-msi": "msi",
  "application/vnd.android.package-archive": "apk",
  "application/x-bittorrent": "torrent",
  "application/json": "json",
  "text/plain": "txt",
  "text/html": "html",
  "text/csv": "csv",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "audio/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** Extensions that make a clipboard link look like a download rather than a web page. */
export const DOWNLOADABLE = new Set(
  Object.values(EXT)
    .flat()
    .filter((e) => !["md", "txt", "csv", "svg", "ico", "ts", "z", "001", "key", "one", "pages", "numbers", "cmd", "bat", "rm", "raw", "mid"].includes(e))
    .concat(["torrent"]),
);

export function categoryOf(filename: string): Category {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (ext === "torrent") return "torrents";
  for (const [cat, list] of Object.entries(EXT)) if (list.includes(ext)) return cat as Category;
  return "other";
}

export function extOf(filename: string): string {
  return path.extname(filename).slice(1).toLowerCase();
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Make a string safe to use as a file name on every OS. */
export function sanitize(name: string): string {
  let s = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (!s) s = "download";
  const ext = path.extname(s);
  const stem = s.slice(0, s.length - ext.length);
  if (RESERVED.test(stem)) s = `_${s}`;
  // keep the name well under the 255-byte limit, preserving the extension
  if (Buffer.byteLength(s) > 200) {
    let cut = stem;
    while (Buffer.byteLength(cut + ext) > 200) cut = cut.slice(0, -1);
    s = cut + ext;
  }
  return s;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parse Content-Disposition, preferring the RFC 5987 `filename*` form. */
export function filenameFromDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    const charset = star[1].toLowerCase();
    const raw = star[2].trim().replace(/^"|"$/g, "");
    if (charset === "utf-8" || charset === "") return decode(raw);
    return Buffer.from(unescape(raw), "latin1").toString("latin1");
  }
  const plain = /filename\s*=\s*("((?:\\.|[^"\\])*)"|[^;]+)/i.exec(header);
  if (plain) {
    const v = plain[2] !== undefined ? plain[2].replace(/\\(.)/g, "$1") : plain[1].trim();
    // servers commonly send raw UTF-8 bytes that Node decodes as latin1
    const fixed = Buffer.from(v, "latin1").toString("utf8");
    return fixed.includes("\uFFFD") ? v : fixed;
  }
  return null;
}

export function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last) return decode(last);
    return u.hostname || null;
  } catch {
    return null;
  }
}

/** Best file name from headers + URL, with an extension guessed from the MIME type when missing. */
export function pickFilename(opts: {
  explicit?: string;
  disposition?: string;
  url: string;
  contentType?: string;
}): string {
  let name = opts.explicit || filenameFromDisposition(opts.disposition) || filenameFromUrl(opts.url) || "download";
  name = sanitize(path.basename(name.replace(/\\/g, "/")));
  if (!path.extname(name) && opts.contentType) {
    const mime = opts.contentType.split(";")[0].trim().toLowerCase();
    const ext = MIME_EXT[mime];
    if (ext && ext !== "html") name += "." + ext;
  }
  return name;
}

/** "file.zip" -> "file (1).zip" -> "file (2).zip" until nothing on disk (or in `taken`) uses it. */
export function uniquePath(dir: string, name: string, taken: Set<string> = new Set()): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; exists(candidate) || taken.has(candidate.toLowerCase()); i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return candidate;
}

function exists(p: string): boolean {
  return fs.existsSync(p) || fs.existsSync(p + ".prism-part");
}

/** Glob on host names: "*.github.com" matches "github.com" and "objects.github.com". */
export function hostMatches(pattern: string, url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return host === base || host.endsWith("." + base);
  }
  if (p.includes("*")) {
    const re = new RegExp("^" + p.split("*").map(escapeRe).join(".*") + "$");
    return re.test(host);
  }
  return host === p || host.endsWith("." + p);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function looksDownloadable(text: string): boolean {
  const t = text.trim();
  if (/^magnet:\?/i.test(t)) return true;
  if (!/^https?:\/\/\S+$/i.test(t)) return false;
  try {
    const u = new URL(t);
    return DOWNLOADABLE.has(extOf(u.pathname));
  } catch {
    return false;
  }
}

export function isMediaSite(url: string): boolean {
  return /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|reddit\.com|soundcloud\.com|bilibili\.com)$/i.test(
    safeHost(url),
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
