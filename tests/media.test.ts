import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptions, formatSelector } from "../src/main/media.js";

// A trimmed-down version of what yt-dlp -J reports for a YouTube video.
const youtube = {
  title: "Example",
  duration: 100,
  formats: [
    { format_id: "sb0", ext: "mhtml", vcodec: "none", acodec: "none", format_note: "storyboard", protocol: "mhtml" },
    { format_id: "139", ext: "m4a", vcodec: "none", acodec: "mp4a.40.5", abr: 48, filesize: 600_000, protocol: "https" },
    { format_id: "140", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", abr: 129, filesize: 1_600_000, protocol: "https" },
    { format_id: "251", ext: "webm", vcodec: "none", acodec: "opus", abr: 135, filesize: 1_500_000, protocol: "https" },
    { format_id: "18", ext: "mp4", vcodec: "avc1.42001E", acodec: "mp4a.40.2", height: 360, fps: 30, tbr: 500, filesize: 6_000_000, protocol: "https" },
    { format_id: "136", ext: "mp4", vcodec: "avc1.4d401f", acodec: "none", height: 720, fps: 30, tbr: 1500, filesize: 18_000_000, protocol: "https" },
    { format_id: "247", ext: "webm", vcodec: "vp9", acodec: "none", height: 720, fps: 30, tbr: 1400, filesize: 17_000_000, protocol: "https" },
    { format_id: "299", ext: "mp4", vcodec: "avc1.64002a", acodec: "none", height: 1080, fps: 60, tbr: 4500, filesize: 55_000_000, protocol: "https" },
    { format_id: "137", ext: "mp4", vcodec: "avc1.640028", acodec: "none", height: 1080, fps: 30, tbr: 3000, filesize: 37_000_000, protocol: "https" },
    { format_id: "313", ext: "webm", vcodec: "vp9", acodec: "none", height: 2160, fps: 30, tbr: 18000, filesize: 220_000_000, protocol: "https" },
    { format_id: "hls-1080", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 1080, fps: 30, tbr: 3200, protocol: "m3u8_native" },
  ],
};

test("one option per resolution, best first, then audio", () => {
  const o = buildOptions(youtube as any);
  assert.deepEqual(
    o.map((x) => x.label),
    ["2160p", "1080p60", "720p", "360p", "Audio", "MP3"],
  );
});

test("separate video gets the matching audio and needs ffmpeg", () => {
  const o = buildOptions(youtube as any);
  const p1080 = o.find((x) => x.height === 1080)!;
  assert.equal(p1080.format, "299+140"); // 60 fps H.264 + AAC, plain HTTP preferred over HLS
  assert.equal(p1080.ext, "mp4");
  assert.equal(p1080.needsFfmpeg, true);
  assert.equal(p1080.stream, false);
  assert.equal(p1080.size, 55_000_000 + 1_600_000);
  const p720 = o.find((x) => x.height === 720)!;
  assert.equal(p720.format, "136+140"); // H.264 preferred over VP9 for compatibility
  const p2160 = o.find((x) => x.height === 2160)!;
  assert.equal(p2160.format, "313+251"); // webm video pairs with webm audio
  assert.equal(p2160.ext, "webm");
});

test("a format that already has audio is used as-is", () => {
  const p360 = buildOptions(youtube as any).find((x) => x.height === 360)!;
  assert.equal(p360.format, "18");
  assert.equal(p360.needsFfmpeg, false);
});

test("audio options: best AAC as-is, and MP3 via ffmpeg", () => {
  const o = buildOptions(youtube as any);
  const a = o.find((x) => x.id === "audio")!;
  assert.equal(a.format, "140");
  assert.equal(a.audioOnly, true);
  const mp3 = o.find((x) => x.id === "mp3")!;
  assert.equal(mp3.convert, "mp3");
  assert.equal(mp3.ext, "mp3");
  assert.equal(mp3.needsFfmpeg, true);
});

test("HLS-only sites are offered, flagged as streams", () => {
  const o = buildOptions({
    title: "Live",
    formats: [
      { format_id: "hls-480", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 480, protocol: "m3u8_native" },
      { format_id: "hls-720", ext: "mp4", vcodec: "avc1", acodec: "mp4a", height: 720, protocol: "m3u8_native" },
    ],
  } as any);
  assert.deepEqual(
    o.map((x) => [x.label, x.stream, x.needsFfmpeg]),
    [
      ["720p", true, false],
      ["480p", true, false],
    ],
  );
});

test("a site with a single unlabelled file still gets an option", () => {
  const o = buildOptions({ title: "clip", ext: "mp4", format_id: "0", url: "https://x/y.mp4", protocol: "https" } as any);
  assert.equal(o.length, 1);
  assert.equal(o[0].format, "0");
});

test("height selector falls back to streams and then anything", () => {
  assert.match(formatSelector("720"), /\[height<=720\]/);
  assert.ok(formatSelector("720").endsWith("/b"));
  assert.ok(formatSelector("audio").startsWith("ba"));
});
