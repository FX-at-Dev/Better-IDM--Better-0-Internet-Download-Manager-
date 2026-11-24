import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Network, NetworkManager } from "../src/main/networks.js";
import { SegmentedDownload } from "../src/main/segmented.js";
import { TokenBucket } from "../src/main/throttle.js";
import { probe } from "../src/main/http.js";
import { SettingsStore } from "../src/main/store.js";
import { Manager } from "../src/main/manager.js";
import { Tools } from "../src/main/tools.js";
import type { NetworkConfig } from "../src/shared/types.js";

const DATA = crypto.randomBytes(6 * 1024 * 1024 + 12345);
const SHA = crypto.createHash("sha256").update(DATA).digest("hex");
const served = new Map<string, number>(); // client address -> bytes
let server: http.Server;
let base = "";
let tmp = "";

function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url!, "http://x");
  const mode = url.pathname.slice(1);
  const addr = req.socket.remoteAddress!.replace("::ffff:", "");
  const send = (buf: Buffer, status: number, headers: Record<string, string | number>) => {
    res.writeHead(status, headers);
    // trickle the body so several connections genuinely overlap
    let off = 0;
    const pump = () => {
      if (off >= buf.length || res.destroyed) return res.end();
      const n = Math.min(64 * 1024, buf.length - off);
      const ok = res.write(buf.subarray(off, off + n));
      served.set(addr, (served.get(addr) ?? 0) + n);
      off += n;
      const next = () => setTimeout(pump, mode === "slow" ? 15 : 1);
      if (ok) next();
      else res.once("drain", next);
    };
    pump();
  };
  if (mode.startsWith("f/")) return send(DATA.subarray(0, 4096), 200, { "Content-Length": 4096 }); // named by its URL
  const disposition = { "Content-Disposition": `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20file.bin` };
  if (mode === "norange") return send(DATA, 200, { "Content-Length": DATA.length, ...disposition });
  if (mode === "chunked") return send(DATA, 200, {});
  const m = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ""));
  if (!m) return send(DATA, 200, { "Content-Length": DATA.length, "Accept-Ranges": "bytes", ...disposition });
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), DATA.length - 1) : DATA.length - 1;
  const claimed = mode === "badrange" && start > 0 ? start + 1 : start;
  send(DATA.subarray(start, end + 1), 206, {
    "Content-Range": `bytes ${claimed}-${end}/${DATA.length}`,
    "Content-Length": end - start + 1,
    ETag: '"v1"',
    ...disposition,
  });
}

function nets(addresses: string[]): NetworkManager {
  const mgr = new NetworkManager(
    () => ({}) as any,
    () => {},
  );
  mgr.nets = new Map(
    addresses.map((a, i) => {
      const cfg: NetworkConfig = { id: `n${i}`, name: `net${i}`, address: a, enabled: true, custom: true, connections: 3, limitKBps: 0 };
      return [cfg.id, new Network(cfg, "#fff")];
    }),
  );
  return mgr;
}

const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prism-test-"));
  server = http.createServer(serve);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function dl(url: string, file: string, mgr: NetworkManager, size: number, ranges: boolean, segments: any[] = []) {
  return new SegmentedDownload({
    url,
    headers: {},
    file,
    size,
    ranges,
    segments,
    nets: mgr,
    globalBucket: new TokenBucket(0),
    connectionsPerNet: () => 3,
    minSegment: 128 * 1024,
    maxFailures: 3,
    onBytes: () => {},
  });
}

test("probe reads size, range support and the RFC 5987 filename", async () => {
  const p = await probe(base + "/ok", {});
  assert.equal(p.size, DATA.length);
  assert.equal(p.ranges, true);
  assert.match(p.disposition ?? "", /UTF-8''/);
  const n = await probe(base + "/norange", {});
  assert.equal(n.ranges, false);
  assert.equal(n.size, DATA.length);
});

test("bonds one file across two interfaces and the checksum matches", async () => {
  served.clear();
  const mgr = nets(["127.0.0.1", "127.0.0.2"]);
  const file = path.join(tmp, "bond.bin");
  const d = dl(base + "/ok", file, mgr, DATA.length, true);
  await d.run(new AbortController().signal);
  assert.equal(sha(file), SHA);
  assert.ok((served.get("127.0.0.1") ?? 0) > 0, "first network carried data");
  assert.ok((served.get("127.0.0.2") ?? 0) > 0, "second network carried data");
  assert.ok(d.segments.length >= 6, "file was split into segments");
});

test("pauses mid-flight and resumes from saved segments", async () => {
  const mgr = nets(["127.0.0.1"]);
  const file = path.join(tmp, "resume.bin");
  const segments: any[] = [];
  const ctrl = new AbortController();
  const first = dl(base + "/slow", file, mgr, DATA.length, true, segments);
  setTimeout(() => ctrl.abort(new Error("pause")), 250);
  await assert.rejects(first.run(ctrl.signal));
  const got = segments.reduce((a, s) => a + s.done, 0);
  assert.ok(got > 0 && got < DATA.length, `partial progress saved (${got})`);
  const saved = JSON.parse(JSON.stringify(segments));
  const second = dl(base + "/ok", file, mgr, DATA.length, true, saved);
  await second.run(new AbortController().signal);
  assert.equal(sha(file), SHA);
});

test("falls back to one connection when the server has no range support", async () => {
  const mgr = nets(["127.0.0.1", "127.0.0.2"]);
  const file = path.join(tmp, "norange.bin");
  const d = dl(base + "/norange", file, mgr, DATA.length, false);
  await d.run(new AbortController().signal);
  assert.equal(sha(file), SHA);
});

test("handles unknown length (chunked) downloads", async () => {
  const mgr = nets(["127.0.0.1"]);
  const file = path.join(tmp, "chunked.bin");
  const d = dl(base + "/chunked", file, mgr, -1, false);
  await d.run(new AbortController().signal);
  assert.equal(d.size, DATA.length);
  assert.equal(sha(file), SHA);
});

test("rejects a server that returns the wrong Content-Range", async () => {
  const mgr = nets(["127.0.0.1"]);
  const file = path.join(tmp, "bad.bin");
  const d = dl(base + "/badrange", file, mgr, DATA.length, true);
  await assert.rejects(d.run(new AbortController().signal), /wrong byte range/);
});

test("manager: downloads, names from headers, verifies checksum, detects duplicates", async () => {
  const dir = path.join(tmp, "mgr");
  fs.mkdirSync(dir);
  const store = new SettingsStore(path.join(dir, "settings.json"));
  store.update({ downloadDir: path.join(dir, "dl"), categorize: true });
  const mgr = new Manager(dir, store, nets(["127.0.0.1", "127.0.0.2"]), new Tools(path.join(dir, "tools")));
  const r = mgr.add({ urls: [base + "/ok"], checksum: { algo: "md5", value: SHA } });
  assert.equal(r.added.length, 1);
  const id = r.added[0];
  for (let i = 0; i < 400; i++) {
    const s = mgr.jobs.get(id)!.status;
    if (s === "completed" || s === "failed") break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const job = mgr.jobs.get(id)!;
  assert.equal(job.status, "completed", job.error ?? "");
  assert.equal(job.filename, "résumé file.bin");
  assert.equal(job.checksum?.algo, "sha256", "algorithm inferred from digest length");
  assert.equal(job.checksum?.state, "ok");
  assert.equal(sha(job.path), SHA);
  assert.ok(!fs.existsSync(job.path + ".prism-part"));
  assert.equal(path.dirname(job.path), path.join(dir, "dl", "Others"), "unknown .bin goes to Others");

  const dup = mgr.add({ urls: [base + "/ok"], source: "ui" });
  assert.equal(dup.added.length, 0);
  assert.equal(dup.duplicates.length, 1);
  const again = mgr.add({ urls: [base + "/ok"], allowDuplicates: true, paused: true });
  assert.equal(again.added.length, 1);
  await mgr.shutdown();
});

test("manager: every download is sorted into a folder by file type", async () => {
  const dir = path.join(tmp, "sort");
  fs.mkdirSync(dir);
  const store = new SettingsStore(path.join(dir, "settings.json"), path.join(dir, "Downloads"));
  assert.equal(store.settings.downloadDir, path.join(dir, "Downloads"), "defaults to the system Downloads folder");
  assert.equal(store.settings.categorize, true);
  const mgr = new Manager(dir, store, nets(["127.0.0.1"]), new Tools(path.join(dir, "tools")));
  const expect: Record<string, string> = {
    "photo.JPG": "Images",
    "shot.webp": "Images",
    "clip.mp4": "Videos",
    "movie.mkv": "Videos",
    "song.mp3": "Music",
    "report.pdf": "Documents",
    "sheet.xlsx": "Documents",
    "backup.zip": "Compressed",
    "disk.iso": "Compressed",
    "setup.exe": "Programs",
    "app.msi": "Programs",
    "data.xyz": "Others",
    "noextension": "Others",
  };
  const r = mgr.add({ urls: Object.keys(expect).map((n) => `${base}/f/${n}`) });
  assert.equal(r.added.length, Object.keys(expect).length);
  for (let i = 0; i < 400; i++) {
    if (r.added.every((id) => ["completed", "failed"].includes(mgr.jobs.get(id)!.status))) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  for (const id of r.added) {
    const job = mgr.jobs.get(id)!;
    assert.equal(job.status, "completed", job.error ?? "");
    const want = expect[job.filename] ?? expect[job.filename.replace(/\.bin$/, "")];
    assert.ok(want, `unexpected name ${job.filename}`);
    assert.equal(path.dirname(job.path), path.join(dir, "Downloads", want), job.filename);
    assert.ok(fs.existsSync(job.path));
  }
  await mgr.shutdown();
});

test("manager: a network that can't reach the server doesn't fail the download", async () => {
  const dir = path.join(tmp, "deadnet");
  fs.mkdirSync(dir);
  const store = new SettingsStore(path.join(dir, "settings.json"), path.join(dir, "Downloads"));
  // 192.0.2.1 (TEST-NET-1) isn't an address of this PC, so binding to it fails — like a LAN-only or VPN adapter
  const mgr = new Manager(dir, store, nets(["192.0.2.1", "127.0.0.1", "127.0.0.2"]), new Tools(path.join(dir, "tools")));
  const r = mgr.add({ urls: [`${base}/f/report.pdf`] });
  const id = r.added[0];
  for (let i = 0; i < 400; i++) {
    if (["completed", "failed"].includes(mgr.jobs.get(id)!.status)) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const job = mgr.jobs.get(id)!;
  assert.equal(job.status, "completed", job.error ?? "");
  assert.equal(fs.statSync(job.path).size, 4096);
  await mgr.shutdown();
});

test("queue windows, including overnight ones", () => {
  const q = { id: "q", name: "q", maxActive: 0, onComplete: "none" as const, schedule: { enabled: true, start: "23:00", stop: "06:00", days: [1] } };
  const at = (d: string) => new Date(d);
  assert.equal(Manager.windowOpen(q, at("2026-11-23T23:30:00")), true); // Monday night
  assert.equal(Manager.windowOpen(q, at("2026-11-24T05:59:00")), true); // Tuesday early (Monday's window)
  assert.equal(Manager.windowOpen(q, at("2026-11-24T06:00:00")), false);
  assert.equal(Manager.windowOpen(q, at("2026-11-24T23:30:00")), false); // Tuesday not selected
  assert.equal(Manager.windowOpen({ ...q, schedule: { ...q.schedule, enabled: false } }, at("2026-11-24T12:00:00")), true);
});
