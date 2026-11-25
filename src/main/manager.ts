import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HttpError, probe, request, type ProbeResult } from "./http.js";
import { NoNetworkError, SegmentedDownload, summarizeSegments, type Segment } from "./segmented.js";
import { SpeedMeter, TokenBucket } from "./throttle.js";
import { categoryOf, hostMatches, isMediaSite, pickFilename, sanitize, uniquePath } from "./naming.js";
import { algoForDigest, hashFile, normalizeDigest } from "./checksum.js";
import { downloadNative, formatSelector, mergeParts, resolveMedia, StreamOnlyError, toMp3 } from "./media.js";
import { addTorrent, type TorrentHandle } from "./torrent.js";
import { readJson, writeJsonAtomic, type SettingsStore } from "./store.js";
import type { Network, NetworkManager } from "./networks.js";
import type { Tools } from "./tools.js";
import { CATEGORY_FOLDER } from "../shared/types.js";
import type {
  AddOptions,
  AddResult,
  Category,
  ChecksumState,
  HashAlgo,
  JobAction,
  JobKind,
  JobStatus,
  JobView,
  QueueDef,
  Totals,
} from "../shared/types.js";

interface MediaPartRecord {
  formatId: string;
  ext: string;
  size: number;
  file: string;
  segments: Segment[];
  done: boolean;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  url: string;
  headers: Record<string, string>;
  filename: string;
  explicitName: boolean;
  baseDir: string;
  autoCategoryDir: boolean;
  fixedCategory: boolean;
  dir: string;
  path: string;
  category: Category;
  queueId: string;
  status: JobStatus;
  error?: string;
  /** transient progress note ("Installing ffmpeg…"), not saved */
  note?: string;
  size: number;
  downloaded: number;
  ranges: boolean;
  probed: boolean;
  etag?: string;
  lastModified?: string;
  segments: Segment[];
  connections: number;
  createdAt: number;
  completedAt?: number;
  checksum?: ChecksumState;
  media?: {
    quality: string; // label shown in the list ("1080p", "Audio")
    /** yt-dlp format selector (from the picker, or built from the default quality) */
    format?: string;
    height?: number;
    ext?: string;
    stream?: boolean;
    convert?: "mp3";
    expectedSize?: number;
    title?: string;
    thumbnail?: string;
    parts: MediaPartRecord[];
    partIndex: number;
  };
  torrent?: { magnet?: string; file?: string; infoHash?: string; uploaded: number };
  order: number;
}

interface Runtime {
  ctrl: AbortController;
  meter: SpeedMeter;
  perNet: Map<string, SpeedMeter>;
  seg?: SegmentedDownload;
  torrent?: TorrentHandle;
}

export interface ManagerHooks {
  onFinished?: (job: JobRecord, ok: boolean) => void;
  onQueueDone?: (queue: QueueDef) => void;
  trash?: (file: string) => Promise<void>;
}

const RUNNING: JobStatus[] = ["probing", "downloading", "merging", "seeding"];
const WAITING: JobStatus[] = ["queued", "scheduled"];
const CATEGORY_DIR = CATEGORY_FOLDER;
const PART = ".lanes-part";

export class Manager {
  jobs = new Map<string, JobRecord>();
  private rt = new Map<string, Runtime>();
  private dirty = false;
  private lastSave = 0;
  private lastSample = 0;
  private queuesRan = new Set<string>();
  readonly globalBucket = new TokenBucket(0);
  readonly totalMeter = new SpeedMeter();
  private jobsFile: string;

  constructor(
    private dataDir: string,
    private store: SettingsStore,
    private nets: NetworkManager,
    private tools: Tools,
    private hooks: ManagerHooks = {},
  ) {
    this.jobsFile = path.join(dataDir, "jobs.json");
  }

  private get s() {
    return this.store.settings;
  }

  // ---------------------------------------------------------------- persistence

  load(): void {
    const saved = readJson<JobRecord[]>(this.jobsFile) ?? [];
    for (const j of saved) {
      if (!j?.id) continue;
      if (RUNNING.includes(j.status) || j.status === "verifying") {
        j.status = this.s.autoResume ? "queued" : "paused";
        if (j.kind === "torrent" && j.status === "queued" && j.completedAt) j.status = "completed";
      }
      if (j.checksum?.state === "running") j.checksum.state = "pending";
      // unfinished downloads from Prism 1.0.0 kept their data in "<file>.prism-part"
      if (j.path && j.status !== "completed" && !fs.existsSync(j.path + PART) && fs.existsSync(j.path + ".prism-part")) {
        try {
          fs.renameSync(j.path + ".prism-part", j.path + PART);
        } catch {}
      }
      this.jobs.set(j.id, j);
    }
  }

  save(force = false): void {
    if (!force && !this.dirty) return;
    const strip = (k: string, v: unknown) => (k === "owner" || k === "net" || k === "note" ? undefined : v);
    const data = JSON.parse(JSON.stringify([...this.jobs.values()], strip));
    writeJsonAtomic(this.jobsFile, data);
    this.dirty = false;
    this.lastSave = Date.now();
  }

  private touch(): void {
    this.dirty = true;
  }

  // ---------------------------------------------------------------- adding

  add(opts: AddOptions): AddResult {
    const result: AddResult = { added: [], duplicates: [], errors: [] };
    const urls = [...new Set(opts.urls.map((u) => u.trim()).filter(Boolean))];
    for (const url of urls) {
      const isMagnet = /^magnet:\?/i.test(url);
      if (!isMagnet && !/^https?:\/\//i.test(url)) {
        result.errors.push(`Not a http(s) or magnet link: ${url.slice(0, 80)}`);
        continue;
      }
      const dup = [...this.jobs.values()].find((j) => j.url === url && j.status !== "failed");
      if (dup && !opts.allowDuplicates) {
        const mode = this.s.duplicateAction;
        if (mode === "skip") continue;
        if (mode === "ask" && (opts.source ?? "ui") === "ui") {
          result.duplicates.push({ url, existingId: dup.id, filename: dup.filename });
          continue;
        }
      }
      const kind: JobKind = isMagnet || /\.torrent(\?|$)/i.test(url) ? "torrent" : opts.media || opts.format || isMediaSite(url) ? "media" : "http";
      const job = this.create(url, kind, opts);
      result.added.push(job.id);
    }
    if (result.added.length) {
      this.touch();
      this.schedule();
    }
    return result;
  }

  addTorrentFile(buf: Buffer, name: string, opts: Partial<AddOptions> = {}): AddResult {
    const dir = path.join(this.dataDir, "torrents");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, crypto.randomUUID() + ".torrent");
    fs.writeFileSync(file, buf);
    const job = this.create("file:" + name, "torrent", { urls: [], ...opts });
    job.torrent = { file, uploaded: 0 };
    job.filename = sanitize(name.replace(/\.torrent$/i, ""));
    this.touch();
    this.schedule();
    return { added: [job.id], duplicates: [], errors: [] };
  }

  private create(url: string, kind: JobKind, opts: AddOptions): JobRecord {
    const rule = this.s.rules.find((r) => r.enabled && hostMatches(r.match, url));
    const baseDir = opts.dir || rule?.folder || this.s.downloadDir;
    const explicitDir = !!(opts.dir || rule?.folder);
    const f = kind === "media" ? opts.format : undefined;
    const name = opts.filename
      ? sanitize(opts.filename)
      : kind === "torrent"
        ? "Torrent"
        : f?.title
          ? sanitize(`${f.title}.${f.ext}`)
          : kind === "media"
            ? "Video"
            : pickFilename({ url });
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.referer) headers.Referer = opts.referer;
    const ua = opts.ua || this.s.userAgent;
    if (ua) headers["User-Agent"] = ua;
    const category: Category = rule?.category || (kind === "torrent" ? "torrents" : kind === "media" ? (f?.audioOnly || opts.quality === "audio" ? "audio" : "video") : categoryOf(name));
    let checksum: ChecksumState | undefined;
    if (opts.checksum?.value) {
      const expected = normalizeDigest(opts.checksum.value);
      checksum = { algo: algoForDigest(expected) ?? opts.checksum.algo, expected, state: "pending" };
    }
    const queueId = opts.queueId || rule?.queueId || "main";
    const job: JobRecord = {
      id: crypto.randomUUID(),
      kind,
      url,
      headers,
      filename: name,
      explicitName: !!opts.filename,
      baseDir,
      autoCategoryDir: this.s.categorize && !explicitDir,
      fixedCategory: !!rule?.category,
      dir: baseDir,
      path: "",
      category,
      queueId: this.s.queues.some((q) => q.id === queueId) ? queueId : "main",
      status: opts.paused ? "paused" : "queued",
      size: -1,
      downloaded: 0,
      ranges: false,
      probed: false,
      segments: [],
      connections: opts.connections || rule?.connections || 0,
      createdAt: Date.now(),
      checksum,
      order: this.maxOrder() + 1,
    };
    if (kind === "media") {
      const q = opts.quality || this.s.defaultQuality;
      job.media = f
        ? {
            quality: f.label,
            format: f.format,
            height: f.height,
            ext: f.ext,
            stream: f.stream,
            convert: f.convert,
            expectedSize: f.size,
            title: f.title,
            thumbnail: f.thumbnail,
            parts: [],
            partIndex: 0,
          }
        : { quality: q === "audio" ? "Audio" : /^\d+$/.test(q) ? `${q}p` : "Best", format: formatSelector(q), height: /^\d+$/.test(q) ? Number(q) : 0, parts: [], partIndex: 0 };
      if (f?.size && f.size > 0) job.size = f.size;
    }
    if (kind === "torrent" && url.startsWith("magnet:")) job.torrent = { magnet: url, uploaded: 0 };
    if (kind === "torrent" && /^https?:/.test(url)) job.torrent = { uploaded: 0 };
    this.jobs.set(job.id, job);
    return job;
  }

  private maxOrder(): number {
    let m = 0;
    for (const j of this.jobs.values()) m = Math.max(m, j.order);
    return m;
  }

  // ---------------------------------------------------------------- scheduling

  queue(id: string): QueueDef {
    return this.s.queues.find((q) => q.id === id) ?? this.s.queues[0];
  }

  /** Is this queue's time window open right now? */
  static windowOpen(q: QueueDef, now = new Date()): boolean {
    const sc = q.schedule;
    if (!sc.enabled) return true;
    const mins = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = sc.start.split(":").map(Number);
    const start = sh * 60 + sm;
    let stop = 24 * 60;
    if (sc.stop) {
      const [eh, em] = sc.stop.split(":").map(Number);
      stop = eh * 60 + em;
    }
    const day = now.getDay();
    const yesterday = (day + 6) % 7;
    if (stop > start) return sc.days.includes(day) && mins >= start && mins < stop;
    // overnight window, e.g. 23:00 → 06:00
    return (sc.days.includes(day) && mins >= start) || (sc.days.includes(yesterday) && mins < stop);
  }

  schedule(): void {
    const now = new Date();
    const all = [...this.jobs.values()];
    // close windows: pause jobs whose queue just ran out of time
    for (const j of all) {
      if (!RUNNING.includes(j.status) || j.status === "seeding") continue;
      const q = this.queue(j.queueId);
      if (q.schedule.enabled && q.schedule.stop && !Manager.windowOpen(q, now)) this.stop(j, "scheduled");
    }
    let active = all.filter((j) => RUNNING.includes(j.status) && j.status !== "seeding").length;
    const waiting = all.filter((j) => WAITING.includes(j.status)).sort((a, b) => a.order - b.order);
    for (const j of waiting) {
      const q = this.queue(j.queueId);
      const open = Manager.windowOpen(q, now);
      const want: JobStatus = open ? "queued" : "scheduled";
      if (j.status !== want) {
        j.status = want;
        this.touch();
      }
      if (!open || active >= this.s.maxActive) continue;
      if (q.maxActive > 0) {
        const inQueue = all.filter((x) => x.queueId === q.id && RUNNING.includes(x.status) && x.status !== "seeding").length;
        if (inQueue >= q.maxActive) continue;
      }
      this.start(j);
      active++;
    }
    this.checkQueuesDone();
  }

  private checkQueuesDone(): void {
    for (const qid of [...this.queuesRan]) {
      const pending = [...this.jobs.values()].some(
        (j) => j.queueId === qid && (WAITING.includes(j.status) || (RUNNING.includes(j.status) && j.status !== "seeding") || j.status === "verifying"),
      );
      if (!pending) {
        this.queuesRan.delete(qid);
        const q = this.queue(qid);
        if (q.onComplete !== "none") this.hooks.onQueueDone?.(q);
      }
    }
  }

  private start(job: JobRecord): void {
    const rt: Runtime = { ctrl: new AbortController(), meter: new SpeedMeter(), perNet: new Map() };
    this.rt.set(job.id, rt);
    this.queuesRan.add(job.queueId);
    job.status = "probing";
    job.error = undefined;
    this.touch();
    const runner = job.kind === "torrent" ? this.runTorrent(job, rt) : job.kind === "media" ? this.runMedia(job, rt) : this.runHttp(job, rt);
    runner
      .then(() => this.hooks.onFinished?.(job, true))
      .catch((e: Error) => {
        if (rt.ctrl.signal.aborted) return; // whoever aborted already set the status
        if (e instanceof NoNetworkError) {
          job.status = "paused";
          job.error = e.message;
          return;
        }
        job.status = "failed";
        job.error = e?.message || String(e);
        this.hooks.onFinished?.(job, false);
      })
      .finally(() => {
        this.rt.delete(job.id);
        this.touch();
        this.save(true);
        setImmediate(() => this.schedule());
      });
  }

  /** Abort a running job and set the status it should rest in. */
  private stop(job: JobRecord, status: JobStatus): void {
    const rt = this.rt.get(job.id);
    job.status = status;
    if (rt) rt.ctrl.abort(new Error("stopped"));
    this.touch();
  }

  private onBytes(rt: Runtime, job: JobRecord) {
    return (n: number, netId: string) => {
      rt.meter.add(n);
      this.totalMeter.add(n);
      let m = rt.perNet.get(netId);
      if (!m) rt.perNet.set(netId, (m = new SpeedMeter()));
      m.add(n);
      this.nets.get(netId)?.meter.add(n);
      job.downloaded += n;
      this.dirty = true;
    };
  }

  private segmentedOpts() {
    return {
      nets: this.nets,
      globalBucket: this.globalBucket,
      connectionsPerNet: () => this.s.connectionsPerNetwork,
      minSegment: this.s.minSegmentKB * 1024,
      maxFailures: Math.max(1, this.s.retries),
    };
  }

  private resolveDir(job: JobRecord): void {
    if (!job.fixedCategory && job.kind === "http") job.category = categoryOf(job.filename);
    const sub = job.autoCategoryDir ? CATEGORY_DIR[job.category] : "";
    job.dir = sub ? path.join(job.baseDir, sub) : job.baseDir;
  }

  private takenPaths(except: string): Set<string> {
    const s = new Set<string>();
    for (const j of this.jobs.values()) if (j.id !== except && j.path) s.add(j.path.toLowerCase());
    return s;
  }

  private assignPath(job: JobRecord): void {
    this.resolveDir(job);
    fs.mkdirSync(job.dir, { recursive: true });
    if (this.s.existingFileAction === "overwrite") job.path = path.join(job.dir, job.filename);
    else job.path = uniquePath(job.dir, job.filename, this.takenPaths(job.id));
    job.filename = path.basename(job.path);
  }

  // ---------------------------------------------------------------- runners

  private async runHttp(job: JobRecord, rt: Runtime): Promise<void> {
    const signal = rt.ctrl.signal;
    const usable = this.nets.usable();
    if (!usable.length) throw new NoNetworkError();
    const p = await this.probeAny(job.url, usable, job.headers, signal);
    if (job.probed && job.downloaded > 0) {
      const changed =
        (job.size >= 0 && p.size >= 0 && p.size !== job.size) ||
        (job.etag && p.etag && job.etag !== p.etag) ||
        (job.lastModified && p.lastModified && job.lastModified !== p.lastModified);
      if (changed) throw new Error("The file changed on the server since this download started — use Restart to download it again");
    }
    if (!job.probed) {
      job.size = p.size;
      job.ranges = p.ranges;
      job.etag = p.etag;
      job.lastModified = p.lastModified;
      job.filename = pickFilename({
        explicit: job.explicitName ? job.filename : undefined,
        disposition: p.disposition,
        url: p.finalUrl,
        contentType: p.contentType,
      });
      this.assignPath(job);
      job.probed = true;
      job.segments = [];
      job.downloaded = 0;
    }
    fs.mkdirSync(job.dir, { recursive: true });
    job.status = "downloading";
    this.touch();
    const seg = new SegmentedDownload({
      ...this.segmentedOpts(),
      url: p.finalUrl,
      headers: job.headers,
      file: job.path + PART,
      size: job.size,
      ranges: job.ranges,
      segments: job.segments,
      connectionsOverride: job.connections,
      onBytes: this.onBytes(rt, job),
    });
    rt.seg = seg;
    job.downloaded = seg.downloaded;
    await seg.run(signal);
    job.size = seg.size;
    job.downloaded = seg.downloaded;
    await this.finalize(job, job.path + PART);
  }

  /**
   * Ask the server about the file over the first network that can reach it. A network that can't
   * (LAN-only adapter, VPN, a local server) mustn't fail the whole download; an actual HTTP answer
   * such as 404 is final. Last resort: Windows' normal route.
   */
  private async probeAny(url: string, nets: Network[], headers: Record<string, string>, signal: AbortSignal): Promise<ProbeResult> {
    let first: unknown;
    for (const net of [...nets, undefined]) {
      try {
        return await probe(url, { net, headers, signal });
      } catch (e) {
        if (e instanceof HttpError || signal.aborted) throw e;
        first ??= e;
      }
    }
    throw first;
  }

  private async runMedia(job: JobRecord, rt: Runtime): Promise<void> {
    const signal = rt.ctrl.signal;
    const media = job.media!;
    const usable = this.nets.usable();
    if (!usable.length) throw new NoNetworkError();
    const selector = media.format || formatSelector("best");
    const onStatus = () => this.touch();
    if (!this.tools.ytdlp) {
      job.note = "Installing yt-dlp (one time)…";
      try {
        await this.tools.ensure("ytdlp", onStatus);
      } finally {
        job.note = undefined;
      }
    }
    if (media.stream) return this.runMediaNative(job, rt, selector);

    let r;
    try {
      r = await resolveMedia(this.tools, job.url, selector, usable, this.s.cookiesFromBrowser, signal);
    } catch (e) {
      if (e instanceof StreamOnlyError) {
        media.stream = true;
        return this.runMediaNative(job, rt, selector);
      }
      throw e;
    }
    media.title = r.title;
    const finalExt = media.convert === "mp3" ? "mp3" : r.ext;
    if (!job.probed) {
      job.filename = sanitize(job.explicitName ? job.filename : `${r.title}.${finalExt}`);
      if (!job.fixedCategory) job.category = media.convert || r.parts.every((p) => p.kind === "audio") ? "audio" : "video";
      job.fixedCategory = true;
      this.assignPath(job);
      job.probed = true;
    }
    media.parts = r.parts.map((p, i) => {
      const prev = media.parts[i];
      const same = prev && prev.formatId === p.formatId;
      return {
        formatId: p.formatId,
        ext: p.ext,
        size: same ? prev.size : p.size,
        file: same ? prev.file : `${job.path}.f${p.formatId.replace(/[^\w-]/g, "")}.${p.ext}${PART}`,
        segments: same ? prev.segments : [],
        done: same ? prev.done : false,
      };
    });
    const sumSize = () => media.parts.reduce((a, p) => a + Math.max(0, p.size), 0);
    job.size = media.parts.every((p) => p.size > 0) ? sumSize() : -1;
    job.status = "downloading";
    this.touch();
    for (let i = 0; i < media.parts.length; i++) {
      const part = media.parts[i];
      media.partIndex = i;
      if (part.done) continue;
      const src = r.parts[i];
      const withSource = usable.filter((n) => src.sources[n.id]);
      const url = src.sources[withSource[0]?.id ?? ""] ?? Object.values(src.sources)[0];
      const p = await this.probeAny(url, withSource.length ? withSource : usable, src.headers, signal);
      if (part.size !== p.size) part.segments = [];
      part.size = p.size;
      job.size = media.parts.every((x) => x.size > 0) ? sumSize() : -1;
      const seg = new SegmentedDownload({
        ...this.segmentedOpts(),
        url,
        sources: src.sources,
        headers: src.headers,
        file: part.file,
        size: p.size,
        ranges: p.ranges,
        segments: part.segments,
        connectionsOverride: job.connections,
        onBytes: this.onBytes(rt, job),
      });
      rt.seg = seg;
      job.downloaded = media.parts.reduce((a, x) => a + x.segments.reduce((b, s) => b + s.done, 0), 0);
      await seg.run(signal);
      part.size = seg.size;
      part.done = true;
      this.touch();
    }
    rt.seg = undefined;

    const needsFfmpeg = media.parts.length > 1 || media.convert === "mp3";
    const ffmpeg = needsFfmpeg ? await this.ffmpegFor(job) : "";
    if (media.parts.length > 1) {
      job.status = "merging";
      this.touch();
      const tmp = `${job.path}.merging${path.extname(job.path)}`;
      await mergeParts(ffmpeg, media.parts.map((p) => p.file), tmp, signal);
      for (const p of media.parts) fs.rmSync(p.file, { force: true });
      await this.finalize(job, tmp);
    } else if (media.convert === "mp3") {
      job.status = "merging";
      this.touch();
      const tmp = `${job.path}.converting.mp3`;
      await toMp3(ffmpeg, media.parts[0].file, tmp, signal);
      fs.rmSync(media.parts[0].file, { force: true });
      await this.finalize(job, tmp);
    } else {
      await this.finalize(job, media.parts[0].file);
    }
  }

  /** ffmpeg, installing it on first use (merging video + audio, MP3). */
  private async ffmpegFor(job: JobRecord): Promise<string> {
    if (this.tools.ffmpeg) return this.tools.ffmpeg;
    job.status = "merging";
    job.note = "Installing ffmpeg (one time)…";
    this.touch();
    try {
      return await this.tools.ensure("ffmpeg", () => this.touch());
    } finally {
      job.note = undefined;
    }
  }

  /** HLS/DASH-only videos: yt-dlp downloads them itself, over Windows' normal route. */
  private async runMediaNative(job: JobRecord, rt: Runtime, selector: string): Promise<void> {
    const media = job.media!;
    if (media.convert === "mp3" || /\+/.test(selector)) await this.ffmpegFor(job);
    if (!job.probed) {
      const ext = media.convert === "mp3" ? "mp3" : media.ext || "mp4";
      if (!job.explicitName && media.title) job.filename = sanitize(`${media.title}.${ext}`);
      if (!job.fixedCategory) job.category = media.convert || media.quality === "Audio" ? "audio" : "video";
      job.fixedCategory = true;
      this.assignPath(job);
      job.probed = true;
    }
    media.parts = [];
    job.status = "downloading";
    job.downloaded = 0;
    if (media.expectedSize && media.expectedSize > 0) job.size = media.expectedSize;
    this.touch();
    const netId = "net-default";
    const onBytes = this.onBytes(rt, job);
    const ext = path.extname(job.path);
    const base = job.path.slice(0, job.path.length - ext.length) + ".lanes-dl";
    const out = await downloadNative(this.tools, {
      url: job.url,
      selector,
      outBase: base,
      ext: ext.slice(1),
      convert: media.convert,
      net: null,
      cookiesFrom: this.s.cookiesFromBrowser,
      signal: rt.ctrl.signal,
      onProgress: (p) => {
        if (p.delta) onBytes(p.delta, netId);
        job.downloaded = p.downloaded;
        if (p.total > 0) job.size = Math.max(p.total, job.downloaded);
        if (job.status === "downloading" && p.total > 0 && p.downloaded >= p.total) job.status = "merging";
      },
    });
    // keep the extension yt-dlp actually produced
    const realExt = path.extname(out);
    if (realExt && realExt.toLowerCase() !== ext.toLowerCase()) {
      job.path = job.path.slice(0, job.path.length - ext.length) + realExt;
      job.filename = path.basename(job.path);
    }
    await this.finalize(job, out);
  }

  private async runTorrent(job: JobRecord, rt: Runtime): Promise<void> {
    const signal = rt.ctrl.signal;
    const tor = (job.torrent ??= { uploaded: 0 });
    if (!job.probed) {
      job.category = "torrents";
      this.resolveDir(job);
      job.probed = true;
    }
    fs.mkdirSync(job.dir, { recursive: true });
    let id: string | Buffer = tor.magnet ?? job.url;
    if (tor.file && fs.existsSync(tor.file)) id = fs.readFileSync(tor.file);
    else if (/^https?:/.test(job.url)) {
      // fetch the .torrent file ourselves so cookies/referer apply
      const { res } = await request(job.url, { headers: job.headers, signal });
      const chunks: Buffer[] = [];
      for await (const c of res as AsyncIterable<Buffer>) chunks.push(c);
      id = Buffer.concat(chunks);
    }
    const t = await addTorrent(id, job.dir, (t) => {
      job.filename = t.name;
      job.size = t.length;
      job.path = path.join(job.dir, t.name);
      tor.infoHash = t.infoHash;
      if (!tor.magnet) tor.magnet = t.magnetURI;
      if (!tor.file && t.torrentFile) {
        const dir = path.join(this.dataDir, "torrents");
        fs.mkdirSync(dir, { recursive: true });
        tor.file = path.join(dir, `${t.infoHash}.torrent`);
        fs.writeFileSync(tor.file, t.torrentFile);
      }
      this.touch();
    });
    rt.torrent = t;
    job.status = "downloading";
    this.touch();
    const baseUploaded = tor.uploaded;
    const cleanup = () => new Promise<void>((r) => t.destroy({ destroyStore: false }, () => r()));
    try {
      await new Promise<void>((resolve, reject) => {
        if (t.done) return resolve();
        t.once("done", () => resolve());
        t.once("error", (e: Error) => reject(e));
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      job.downloaded = job.size = t.length;
      job.completedAt = Date.now();
      if (this.s.seedRatio > 0) {
        job.status = "seeding";
        this.touch();
        await new Promise<void>((resolve) => {
          const iv = setInterval(() => {
            tor.uploaded = baseUploaded + t.uploaded;
            if (signal.aborted || tor.uploaded / Math.max(1, t.length) >= this.s.seedRatio) {
              clearInterval(iv);
              resolve();
            }
          }, 1000);
        });
      }
    } finally {
      tor.uploaded = baseUploaded + (t.uploaded || 0);
      await cleanup();
    }
    if (signal.aborted && job.status !== "seeding") throw signal.reason;
    job.status = "completed";
    job.completedAt = Date.now();
    this.touch();
  }

  /** Move the finished part file into place and verify it. */
  private async finalize(job: JobRecord, from: string): Promise<void> {
    if (fs.existsSync(job.path)) {
      if (this.s.existingFileAction === "overwrite") await fs.promises.rm(job.path, { force: true });
      else {
        job.path = uniquePath(path.dirname(job.path), path.basename(job.path), this.takenPaths(job.id));
        job.filename = path.basename(job.path);
      }
    }
    await fs.promises.rename(from, job.path);
    job.downloaded = job.size = (await fs.promises.stat(job.path)).size;
    job.segments = [];
    if (job.media) for (const p of job.media.parts) p.segments = [];
    job.completedAt = Date.now();
    if (job.checksum?.expected || this.s.autoHash) await this.verify(job);
    job.status = "completed";
    this.touch();
  }

  async verify(job: JobRecord, algo?: HashAlgo): Promise<void> {
    if (!job.path || !fs.existsSync(job.path) || fs.statSync(job.path).isDirectory()) {
      job.checksum = { algo: algo ?? this.s.hashAlgo, state: "error", expected: job.checksum?.expected };
      return;
    }
    const cs: ChecksumState = job.checksum ?? { algo: algo ?? this.s.hashAlgo, state: "pending" };
    if (algo && !cs.expected) cs.algo = algo;
    cs.state = "running";
    cs.progress = 0;
    job.checksum = cs;
    const prev = job.status;
    job.status = "verifying";
    this.touch();
    try {
      cs.actual = await hashFile(job.path, cs.algo, (f) => (cs.progress = f));
      cs.state = cs.expected ? (cs.expected === cs.actual ? "ok" : "mismatch") : "computed";
    } catch {
      cs.state = "error";
    } finally {
      cs.progress = undefined;
      job.status = prev === "verifying" ? "completed" : prev;
      this.touch();
    }
  }

  // ---------------------------------------------------------------- actions

  async action(ids: string[], action: JobAction): Promise<void> {
    for (const id of ids) {
      const job = this.jobs.get(id);
      if (!job) continue;
      switch (action) {
        case "pause":
          if (RUNNING.includes(job.status) || WAITING.includes(job.status)) {
            if (job.status === "seeding") this.stop(job, "completed");
            else this.stop(job, "paused");
          }
          break;
        case "resume":
          if (job.status === "paused" || job.status === "failed") {
            job.status = "queued";
            job.error = undefined;
          }
          break;
        case "retry":
          if (job.status === "failed" || job.status === "paused") {
            job.status = "queued";
            job.error = undefined;
          }
          break;
        case "restart":
          if (this.rt.has(job.id)) this.stop(job, "queued");
          await this.waitStopped(job.id);
          this.removeParts(job);
          job.segments = [];
          job.downloaded = 0;
          job.probed = job.kind === "torrent" ? job.probed : false;
          job.size = -1;
          if (job.media) job.media.parts = [];
          job.status = "queued";
          job.error = undefined;
          if (job.checksum) job.checksum = { algo: job.checksum.algo, expected: job.checksum.expected, state: "pending" };
          break;
        case "cancel":
        case "remove":
        case "delete": {
          if (this.rt.has(job.id)) this.stop(job, "paused");
          await this.waitStopped(job.id);
          if (job.status !== "completed" || action !== "remove") this.removeParts(job);
          if (action === "delete" && job.path && fs.existsSync(job.path)) {
            if (this.hooks.trash) await this.hooks.trash(job.path).catch(() => {});
            else await fs.promises.rm(job.path, { recursive: true, force: true });
          }
          if (job.torrent?.file) fs.rmSync(job.torrent.file, { force: true });
          this.jobs.delete(job.id);
          break;
        }
        case "verify":
          if (job.status === "completed") void this.verify(job);
          break;
        case "top":
          job.order = Math.min(...[...this.jobs.values()].map((j) => j.order)) - 1;
          break;
        case "bottom":
          job.order = this.maxOrder() + 1;
          break;
      }
    }
    this.touch();
    this.save(true);
    this.schedule();
  }

  private removeParts(job: JobRecord): void {
    if (job.kind === "torrent") return;
    if (job.path) fs.rmSync(job.path + PART, { force: true });
    for (const p of job.media?.parts ?? []) fs.rmSync(p.file, { force: true });
    if (job.path) fs.rmSync(`${job.path}.merging${path.extname(job.path)}`, { force: true });
    if (job.path && job.kind === "media") {
      // yt-dlp's own partial files: "<name>.lanes-dl.*"
      const ext = path.extname(job.path);
      const stem = path.basename(job.path, ext) + ".lanes-dl";
      try {
        for (const f of fs.readdirSync(path.dirname(job.path))) if (f.startsWith(stem)) fs.rmSync(path.join(path.dirname(job.path), f), { force: true });
      } catch {}
    }
  }

  private async waitStopped(id: string): Promise<void> {
    for (let i = 0; i < 100 && this.rt.has(id); i++) await new Promise((r) => setTimeout(r, 50));
  }

  moveToQueue(ids: string[], queueId: string): void {
    if (!this.s.queues.some((q) => q.id === queueId)) return;
    for (const id of ids) {
      const j = this.jobs.get(id);
      if (j) j.queueId = queueId;
    }
    this.touch();
    this.schedule();
  }

  setChecksum(id: string, algo: HashAlgo, expected: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const e = normalizeDigest(expected);
    const a = (e && algoForDigest(e)) || algo;
    job.checksum = { algo: a, expected: e || undefined, actual: job.checksum?.algo === a ? job.checksum.actual : undefined, state: "pending" };
    if (job.checksum.actual && e) job.checksum.state = job.checksum.actual === e ? "ok" : "mismatch";
    else if (job.status === "completed") void this.verify(job);
    this.touch();
  }

  pauseAll(): void {
    for (const j of this.jobs.values()) if (RUNNING.includes(j.status) && j.status !== "seeding") this.stop(j, "paused");
    for (const j of this.jobs.values()) if (WAITING.includes(j.status)) j.status = "paused";
    this.touch();
  }

  resumeAll(): void {
    for (const j of this.jobs.values()) if (j.status === "paused") (j.status = "queued"), (j.error = undefined);
    this.touch();
    this.schedule();
  }

  clearCompleted(): void {
    for (const [id, j] of this.jobs) if (j.status === "completed") this.jobs.delete(id);
    this.touch();
  }

  /** Stop everything for app exit; running jobs resume next launch. */
  async shutdown(): Promise<void> {
    for (const j of this.jobs.values()) if (RUNNING.includes(j.status)) this.stop(j, j.status === "seeding" ? "completed" : "queued");
    for (let i = 0; i < 60 && this.rt.size; i++) await new Promise((r) => setTimeout(r, 50));
    this.save(true);
  }

  // ---------------------------------------------------------------- ticking & views

  tick(): void {
    const now = Date.now();
    this.globalBucket.setRate(this.s.globalLimitKBps * 1024);
    this.totalMeter.tick(now);
    this.nets.tick();
    for (const [id, rt] of this.rt) {
      rt.meter.tick(now);
      for (const m of rt.perNet.values()) m.tick(now);
      const job = this.jobs.get(id);
      if (job && rt.torrent) {
        job.downloaded = rt.torrent.downloaded;
        if (rt.torrent.length) job.size = rt.torrent.length;
      }
    }
    if (now - this.lastSample >= 1000) {
      this.lastSample = now;
      let torrentSpeed = 0;
      for (const rt of this.rt.values()) if (rt.torrent) torrentSpeed += rt.torrent.downloadSpeed;
      this.totalMeter.history.push(Math.round(this.totalMeter.speed + torrentSpeed));
      if (this.totalMeter.history.length > 90) this.totalMeter.history.shift();
      this.nets.sample();
      for (const rt of this.rt.values()) {
        if (rt.torrent) {
          rt.meter.history.push(Math.round(rt.torrent.downloadSpeed));
          if (rt.meter.history.length > 90) rt.meter.history.shift();
        } else rt.meter.sample();
      }
      this.schedule();
    }
    if (this.dirty && now - this.lastSave > 3000) this.save();
  }

  view(job: JobRecord): JobView {
    const rt = this.rt.get(job.id);
    const t = rt?.torrent;
    const speed = t ? t.downloadSpeed : (rt?.meter.speed ?? 0);
    const left = job.size >= 0 ? job.size - job.downloaded : -1;
    const segs = rt?.seg ? rt.seg.segments : job.kind === "media" ? (job.media?.parts[job.media.partIndex]?.segments ?? []) : job.segments;
    const segSize = rt?.seg ? rt.seg.size : job.kind === "media" ? (job.media?.parts[job.media.partIndex]?.size ?? -1) : job.size;
    const perNet: JobView["perNet"] = {};
    if (rt) for (const [id, m] of rt.perNet) perNet[id] = { bytes: m.total, speed: m.speed };
    return {
      id: job.id,
      kind: job.kind,
      url: job.url,
      filename: job.filename,
      dir: job.dir,
      path: job.path,
      category: job.category,
      queueId: job.queueId,
      status: job.status,
      error: job.error,
      note: job.note,
      size: job.size,
      downloaded: job.downloaded,
      speed,
      eta: speed > 0 && left >= 0 ? Math.round(left / speed) : -1,
      resumable: job.kind !== "http" || job.ranges || !job.probed,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      connections: rt?.seg ? rt.seg.activeConnections : t ? t.numPeers : 0,
      segments: segSize > 0 ? summarizeSegments(segs as any, segSize) : [],
      perNet,
      history: rt ? rt.meter.history.slice(-60) : [],
      checksum: job.checksum,
      media: job.media
        ? {
            quality: job.media.quality,
            title: job.media.title,
            parts: job.media.parts.length,
            partIndex: job.media.partIndex,
            stream: job.media.stream,
            thumbnail: job.media.thumbnail,
          }
        : undefined,
      torrent: job.torrent
        ? {
            infoHash: job.torrent.infoHash,
            peers: t?.numPeers ?? 0,
            uploaded: job.torrent.uploaded + (t?.uploaded ?? 0),
            upSpeed: t?.uploadSpeed ?? 0,
            ratio: (job.torrent.uploaded + (t?.uploaded ?? 0)) / Math.max(1, job.size),
            files: t?.files?.length ?? 0,
          }
        : undefined,
      order: job.order,
    };
  }

  views(): JobView[] {
    return [...this.jobs.values()].sort((a, b) => a.order - b.order).map((j) => this.view(j));
  }

  totals(): Totals {
    let active = 0,
      queued = 0,
      completed = 0,
      failed = 0;
    for (const j of this.jobs.values()) {
      if (RUNNING.includes(j.status)) active++;
      else if (WAITING.includes(j.status)) queued++;
      else if (j.status === "completed") completed++;
      else if (j.status === "failed") failed++;
    }
    let torrentSpeed = 0;
    for (const rt of this.rt.values()) if (rt.torrent) torrentSpeed += rt.torrent.downloadSpeed;
    return {
      speed: this.totalMeter.speed + torrentSpeed,
      active,
      queued,
      completed,
      failed,
      history: this.totalMeter.history.slice(-60),
    };
  }

  isRunning(id: string): boolean {
    return this.rt.has(id);
  }
}
