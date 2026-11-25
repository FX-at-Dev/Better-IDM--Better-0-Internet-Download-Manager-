import { spawn } from "node:child_process";
import { run, killTree, type Tools } from "./tools.js";
import type { Network } from "./networks.js";
import type { MediaInfo, MediaOption } from "../shared/types.js";

export interface MediaPart {
  formatId: string;
  ext: string;
  kind: "video" | "audio" | "both";
  /** network id -> direct URL resolved from that network's IP */
  sources: Record<string, string>;
  headers: Record<string, string>;
  size: number;
}

export interface Resolved {
  title: string;
  ext: string; // final container
  parts: MediaPart[];
}

/** The chosen formats are HLS/DASH streams, which yt-dlp has to download itself. */
export class StreamOnlyError extends Error {
  constructor() {
    super("stream-only");
  }
}

const HTTP = "[protocol^=http][protocol!*=dash][protocol!*=m3u8]";

/** Height-based selector for downloads added without the picker (extension, bulk add). Plain HTTP first, streams as a fallback. */
export function formatSelector(quality: string): string {
  if (quality === "audio") return `ba${HTTP}/ba/b`;
  const h = /^\d+$/.test(quality) ? `[height<=${quality}]` : "";
  return `bv*${h}${HTTP}+ba${HTTP}/b${h}${HTTP}/bv*${h}+ba/b${h}/b`;
}

interface YtFormat {
  format_id: string;
  url?: string;
  ext: string;
  vcodec?: string | null;
  acodec?: string | null;
  protocol?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
  abr?: number | null;
  audio_channels?: number | null;
  height?: number | null;
  fps?: number | null;
  format_note?: string;
  http_headers?: Record<string, string>;
}

interface YtInfo extends YtFormat {
  _type?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  extractor_key?: string;
  webpage_url_domain?: string;
  formats?: YtFormat[];
  requested_formats?: YtFormat[];
  entries?: { url?: string; webpage_url?: string }[];
  playlist_count?: number;
}

function commonArgs(tools: Tools, net: Network | null, cookiesFrom: string): string[] {
  const args = ["--no-warnings", "--no-playlist"];
  if (net?.cfg.address) args.push("--source-address", net.cfg.address);
  if (cookiesFrom) args.push("--cookies-from-browser", cookiesFrom);
  const js = tools.jsRuntime;
  if (js) args.push("--js-runtimes", js);
  return args;
}

function ytdlp(tools: Tools): string {
  const bin = tools.ytdlp;
  if (!bin) throw new Error("Video sites need yt-dlp — install it from Settings → Video");
  return bin;
}

// ------------------------------------------------------------------ quality picker

const isStream = (f: YtFormat) => /m3u8|dash|f4m|ism/i.test(f.protocol ?? "");
const AUDIO_EXT = /^(m4a|mp3|opus|ogg|oga|aac|flac|wav|weba|mka)$/i;
const hasVideo = (f: YtFormat) =>
  f.vcodec !== "none" && !(AUDIO_EXT.test(f.ext) && !f.height) && (!!f.height || (f.vcodec != null && f.vcodec !== "none") || f.acodec == null);
const hasAudio = (f: YtFormat) => f.acodec !== "none" && (f.acodec != null || f.vcodec == null || AUDIO_EXT.test(f.ext));

function codecName(c?: string | null): string {
  if (!c || c === "none") return "";
  if (/^avc|^h264/i.test(c)) return "H.264";
  if (/^hev|^hvc|^h265/i.test(c)) return "H.265";
  if (/^vp0?9/i.test(c)) return "VP9";
  if (/^av01/i.test(c)) return "AV1";
  if (/^mp4a|^aac/i.test(c)) return "AAC";
  if (/opus/i.test(c)) return "Opus";
  if (/mp3/i.test(c)) return "MP3";
  return c.split(".")[0].toUpperCase();
}

function sizeOf(f: YtFormat, duration?: number): number {
  const s = f.filesize ?? f.filesize_approx;
  if (s && s > 0) return s;
  if (f.tbr && duration) return Math.round((f.tbr * 1000 * duration) / 8);
  return -1;
}

const add = (a: number, b: number) => (a < 0 || b < 0 ? -1 : a + b);

/** Turn yt-dlp's format list into a short, human list: one entry per resolution plus audio. */
export function buildOptions(info: YtInfo): MediaOption[] {
  const fmts = (info.formats?.length ? info.formats : [info]).filter((f) => f.format_id && f.ext !== "mhtml" && !/storyboard/i.test(f.format_note ?? ""));
  const dur = info.duration;
  const audios = fmts.filter((f) => hasAudio(f) && !hasVideo(f));
  let videos = fmts.filter(hasVideo);
  if (videos.some((f) => f.height)) videos = videos.filter((f) => f.height); // drop unlabelled extras when real resolutions exist

  const codecScore = (c?: string | null) => (/^avc/i.test(c ?? "") ? 3 : /^vp0?9/i.test(c ?? "") ? 2 : /^av01/i.test(c ?? "") ? 1 : 2);
  // plain HTTP > matching container > stereo > not dynamic-range-compressed > bitrate
  const audioScore = (a: YtFormat, preferExt?: string) =>
    (isStream(a) ? 0 : 1e7) +
    (preferExt && extFamily(a.ext) === preferExt ? 1e6 : 0) +
    ((a.audio_channels ?? 2) <= 2 ? 1e5 : 0) +
    (/drc/i.test(a.format_id + (a.format_note ?? "")) ? 0 : 1e4) +
    (a.abr ?? a.tbr ?? 0);
  const bestAudio = (preferExt?: string) => [...audios].sort((a, b) => audioScore(b, preferExt) - audioScore(a, preferExt))[0];

  // best video format per height
  const byHeight = new Map<number, YtFormat>();
  for (const f of videos) {
    const h = f.height ?? 0;
    const score = (x: YtFormat) => (isStream(x) ? 0 : 1e7) + ((x.fps ?? 30) >= 50 ? 1e6 : 0) + codecScore(x.vcodec) * 1e5 + (hasAudio(x) ? 5e4 : 0) + (x.tbr ?? 0);
    const cur = byHeight.get(h);
    if (!cur || score(f) > score(cur)) byHeight.set(h, f);
  }

  const out: MediaOption[] = [];
  for (const [h, v] of [...byHeight.entries()].sort((a, b) => b[0] - a[0])) {
    const fps = v.fps && v.fps >= 50 ? Math.round(v.fps) : 0;
    const label = h ? `${h}p${fps ? fps : ""}` : "Video";
    if (hasAudio(v) || !audios.length) {
      out.push({
        id: `v${h}`,
        format: v.format_id,
        label,
        detail: [v.ext.toUpperCase(), codecName(v.vcodec)].filter(Boolean).join(" · "),
        height: h,
        ext: v.ext,
        size: sizeOf(v, dur),
        audioOnly: false,
        needsFfmpeg: false,
        stream: isStream(v),
      });
      continue;
    }
    const a = bestAudio(extFamily(v.ext))!;
    const ext = extFamily(v.ext) === "mp4" && extFamily(a.ext) === "mp4" ? "mp4" : v.ext === "webm" && a.ext === "webm" ? "webm" : "mkv";
    out.push({
      id: `v${h}`,
      format: `${v.format_id}+${a.format_id}`,
      label,
      detail: [ext.toUpperCase(), codecName(v.vcodec)].filter(Boolean).join(" · "),
      height: h,
      ext,
      size: add(sizeOf(v, dur), sizeOf(a, dur)),
      audioOnly: false,
      needsFfmpeg: true,
      stream: isStream(v) || isStream(a),
    });
  }

  const a = bestAudio("mp4") ?? bestAudio();
  if (a) {
    const kbps = Math.round(a.abr ?? a.tbr ?? 0);
    const ext = a.ext === "webm" ? "opus" : a.ext;
    out.push({
      id: "audio",
      format: a.format_id,
      label: "Audio",
      detail: [ext.toUpperCase(), kbps ? `${kbps} kbps` : ""].filter(Boolean).join(" · "),
      height: 0,
      ext: a.ext,
      size: sizeOf(a, dur),
      audioOnly: true,
      needsFfmpeg: false,
      stream: isStream(a),
    });
    out.push({
      id: "mp3",
      format: a.format_id,
      label: "MP3",
      detail: "Converted · 192 kbps",
      height: 0,
      ext: "mp3",
      size: dur ? Math.round((192_000 / 8) * dur) : -1,
      audioOnly: true,
      needsFfmpeg: true,
      stream: isStream(a),
      convert: "mp3",
    });
  } else if (!out.length) {
    // nothing we could classify: let yt-dlp pick
    out.push({ id: "best", format: "b/bv*+ba", label: "Best", detail: "Best available", height: 0, ext: info.ext || "mp4", size: sizeOf(info, dur), audioOnly: false, needsFfmpeg: false, stream: isStream(info) });
  }
  return out;
}

function extFamily(ext: string): string {
  return ["mp4", "m4a", "m4v", "mov"].includes(ext) ? "mp4" : ext;
}

/** Options for a playlist, where formats aren't known per video yet. */
function playlistOptions(): MediaOption[] {
  const mk = (h: number, label: string): MediaOption => ({
    id: `v${h}`,
    format: formatSelector(h ? String(h) : "best"),
    label,
    detail: h ? `Up to ${h}p` : "Highest available",
    height: h,
    ext: "mp4",
    size: -1,
    audioOnly: false,
    needsFfmpeg: true,
    stream: false,
  });
  return [
    mk(0, "Best"),
    mk(2160, "4K"),
    mk(1080, "1080p"),
    mk(720, "720p"),
    mk(480, "480p"),
    { id: "audio", format: formatSelector("audio"), label: "Audio", detail: "Best audio", height: 0, ext: "m4a", size: -1, audioOnly: true, needsFfmpeg: false, stream: false },
  ];
}

/** Ask yt-dlp what a page offers, for the quality picker. */
export async function probeMedia(tools: Tools, url: string, net: Network | null, cookiesFrom: string, signal?: AbortSignal): Promise<MediaInfo> {
  const bin = ytdlp(tools);
  const args = ["-J", "--flat-playlist", ...commonArgs(tools, net, cookiesFrom), "--", url];
  const info = JSON.parse(await run(bin, args, { signal, timeoutMs: 90_000, env: tools.env })) as YtInfo;
  const site = (info.webpage_url_domain ?? hostOf(url)).replace(/^(www|m)\./, "");
  if (info._type === "playlist") {
    const entries = (info.entries ?? []).map((e) => e.url || e.webpage_url || "").filter((u) => /^https?:/.test(u));
    if (!entries.length) throw new Error("This playlist is empty or private");
    return { url, title: info.title || "Playlist", site, uploader: info.uploader || info.channel, options: playlistOptions(), playlist: { count: entries.length, entries } };
  }
  const options = buildOptions(info);
  return {
    url,
    title: info.title || "video",
    site,
    uploader: info.uploader || info.channel,
    duration: info.duration,
    thumbnail: info.thumbnail,
    options,
  };
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ resolving for the segmented engine

async function resolveOn(tools: Tools, pageUrl: string, selector: string, net: Network | null, cookiesFrom: string, signal?: AbortSignal): Promise<YtInfo> {
  const args = ["-J", "-f", selector, ...commonArgs(tools, net, cookiesFrom), "--", pageUrl];
  const info = JSON.parse(await run(ytdlp(tools), args, { signal, timeoutMs: 120_000, env: tools.env })) as YtInfo;
  if (info._type === "playlist") throw new Error("This link is a playlist — add it from the New download dialog");
  return info;
}

function partsOf(info: YtInfo): YtFormat[] {
  return info.requested_formats?.length ? info.requested_formats : [info];
}

function containerFor(parts: YtFormat[]): string {
  if (parts.length === 1) return parts[0].ext;
  const exts = parts.map((p) => extFamily(p.ext));
  if (exts.every((e) => e === "webm")) return "webm";
  if (exts.every((e) => e === "mp4")) return "mp4";
  return "mkv";
}

/**
 * Resolve the page once per network. Media links are usually locked to the IP
 * that asked for them, so each network gets its own URL for the same format.
 */
export async function resolveMedia(tools: Tools, pageUrl: string, selector: string, nets: Network[], cookiesFrom: string, signal?: AbortSignal): Promise<Resolved> {
  const targets = nets.length ? nets : [null];
  const results = await Promise.allSettled(targets.map((n) => resolveOn(tools, pageUrl, selector, n, cookiesFrom, signal)));
  const ok = results
    .map((r, i) => ({ r, net: targets[i] }))
    .filter((x): x is { r: PromiseFulfilledResult<YtInfo>; net: Network | null } => x.r.status === "fulfilled");
  if (!ok.length) {
    const first = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw first?.reason instanceof Error ? first.reason : new Error("Could not resolve the video");
  }
  const primary = ok[0].r.value;
  const fmts = partsOf(primary);
  if (fmts.some((f) => isStream(f) || !f.url)) throw new StreamOnlyError();
  const parts: MediaPart[] = fmts.map((f) => {
    const sources: Record<string, string> = {};
    for (const { r, net } of ok) {
      const match = partsOf(r.value).find((x) => x.format_id === f.format_id);
      if (match?.url) sources[net?.id ?? "net-default"] = match.url;
    }
    const kind: MediaPart["kind"] = hasVideo(f) ? (hasAudio(f) ? "both" : "video") : "audio";
    return { formatId: f.format_id, ext: f.ext, kind, sources, headers: f.http_headers ?? {}, size: f.filesize ?? f.filesize_approx ?? -1 };
  });
  return { title: primary.title || "video", ext: containerFor(fmts), parts };
}

export async function mergeParts(ffmpeg: string, inputs: string[], output: string, signal?: AbortSignal): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const i of inputs) args.push("-i", i);
  for (let k = 0; k < inputs.length; k++) args.push("-map", String(k));
  args.push("-c", "copy", output);
  await run(ffmpeg, args, { signal, timeoutMs: 30 * 60_000 });
}

export async function toMp3(ffmpeg: string, input: string, output: string, signal?: AbortSignal): Promise<void> {
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", output], { signal, timeoutMs: 30 * 60_000 });
}

// ------------------------------------------------------------------ yt-dlp's own downloader (HLS / DASH)

export interface NativeProgress {
  downloaded: number; // across all files so far
  total: number; // -1 unknown
  delta: number; // new bytes since the last report
}

/**
 * Let yt-dlp download a stream-only video itself (HLS/DASH fragments, merging, MP3).
 * Resolves with the final file path.
 */
export function downloadNative(
  tools: Tools,
  o: { url: string; selector: string; outBase: string; ext: string; convert?: "mp3"; net: Network | null; cookiesFrom: string; signal: AbortSignal; onProgress: (p: NativeProgress) => void },
): Promise<string> {
  const bin = ytdlp(tools);
  const args = [
    "-f",
    o.selector,
    ...commonArgs(tools, o.net, o.cookiesFrom),
    "--newline",
    "--quiet",
    "--progress",
    "--no-mtime",
    "-N",
    "6",
    "--progress-template",
    "download:LANES|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.filename)s",
    "--print",
    "after_move:LANESFILE|%(filepath)s",
    "-o",
    `${o.outBase}.%(ext)s`,
  ];
  if (tools.ffmpeg) args.push("--ffmpeg-location", tools.ffmpeg);
  if (o.convert === "mp3") args.push("-x", "--audio-format", "mp3", "--audio-quality", "192K");
  else if (o.ext && ["mp4", "mkv", "webm"].includes(o.ext)) args.push("--merge-output-format", o.ext);
  args.push("--", o.url);

  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, env: { ...process.env, ...tools.env } });
    const files = new Map<string, { got: number; total: number }>();
    let reported = 0;
    let final = "";
    let errTail = "";
    const onAbort = () => killTree(p.pid);
    o.signal.addEventListener("abort", onAbort, { once: true });

    const handle = (line: string) => {
      if (line.startsWith("LANESFILE|")) {
        final = line.slice(10).trim();
        return;
      }
      const i = line.indexOf("LANES|");
      if (i < 0) {
        if (/ERROR/.test(line)) errTail = line.replace(/^.*?ERROR:\s*/, "");
        return;
      }
      const [, got, total, est, file] = line.slice(i).split("|");
      const g = Number(got) || 0;
      const t = Number(total) || Number(est) || -1;
      files.set(file ?? "", { got: g, total: t });
      let downloaded = 0;
      let all = 0;
      for (const f of files.values()) {
        downloaded += f.got;
        all = f.total > 0 && all >= 0 ? all + f.total : -1;
      }
      const delta = Math.max(0, downloaded - reported);
      reported = Math.max(reported, downloaded);
      o.onProgress({ downloaded, total: all, delta });
    };
    let buf = "";
    const feed = (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) handle(l.trim());
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("error", (e) => {
      o.signal.removeEventListener("abort", onAbort);
      reject(e);
    });
    p.on("close", (code) => {
      o.signal.removeEventListener("abort", onAbort);
      if (buf.trim()) handle(buf.trim());
      if (o.signal.aborted) return reject(new Error("stopped"));
      if (code === 0 && final) resolve(final);
      else reject(new Error(errTail || `yt-dlp exited with code ${code}`));
    });
  });
}
