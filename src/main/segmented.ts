import fs from "node:fs";
import { execFile } from "node:child_process";
import { HttpError, request } from "./http.js";
import { sleep, TokenBucket } from "./throttle.js";
import type { Network, NetworkManager } from "./networks.js";

/** The download's file was deleted while it was downloading. */
export class FileGoneError extends Error {
  constructor() {
    super("The file was deleted while downloading — use Restart to download it again");
  }
}

/** Mark a new, empty file as sparse on Windows (no admin needed). Harmless if it fails. */
function makeSparse(file: string): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve) => execFile("fsutil", ["sparse", "setflag", file], { windowsHide: true, timeout: 5000 }, () => resolve()));
}

/** Persisted byte range. `end` is exclusive; -1 means "until the server stops" (unknown size). */
export interface Segment {
  start: number;
  end: number;
  done: number;
}

interface LiveSegment extends Segment {
  owner?: number;
  net?: string;
}

export class NoNetworkError extends Error {
  constructor() {
    super("No enabled network is available — turn one on to continue");
  }
}

export interface SegmentedOptions {
  url: string;
  /** Per-network URLs for IP-locked media links. Networks without one sit this download out. */
  sources?: Record<string, string>;
  headers: Record<string, string>;
  file: string;
  size: number;
  ranges: boolean;
  segments: Segment[];
  nets: NetworkManager;
  globalBucket: TokenBucket;
  connectionsPerNet: () => number;
  connectionsOverride?: number;
  minSegment: number;
  maxFailures: number;
  onBytes: (n: number, netId: string) => void;
}

const MAX_SLICE = 256 * 1024;

/**
 * Downloads one file over every usable network at once.
 *
 * The file is split into segments; each network runs N workers that claim free
 * segments. When nothing is free, an idle worker splits the largest remaining
 * segment in half (work stealing), so fast networks naturally carry more of
 * the file and nobody idles at the end. Every ranged response is checked
 * (206 + matching Content-Range) before a single byte is written.
 */
export class SegmentedDownload {
  segments: LiveSegment[];
  size: number;
  private fh!: fs.promises.FileHandle;
  private workers = new Map<number, { net: string; p: Promise<void> }>();
  private nextWorker = 1;
  private failures = new Map<string, number>();
  private dropped = new Set<string>();
  private lastError: Error | null = null;
  private ctrl = new AbortController();
  private settle!: { resolve: () => void; reject: (e: Error) => void };
  private finished = false;

  constructor(private o: SegmentedOptions) {
    this.size = o.size;
    this.segments = o.segments as LiveSegment[];
    if (!this.segments.length) this.segments.push(...this.initialSegments());
    if (!o.ranges) {
      // without range support we can only stream from the start on one connection
      this.segments.length = 0;
      this.segments.push({ start: 0, end: o.size >= 0 ? o.size : -1, done: 0 });
    }
  }

  private initialSegments(): Segment[] {
    const { size, ranges } = this.o;
    if (!ranges || size <= 0) return [{ start: 0, end: size >= 0 ? size : -1, done: 0 }];
    const want = Math.max(1, this.wantedTotal());
    const n = Math.max(1, Math.min(want, Math.floor(size / this.o.minSegment)));
    const step = Math.ceil(size / n);
    const segs: Segment[] = [];
    for (let s = 0; s < size; s += step) segs.push({ start: s, end: Math.min(size, s + step), done: 0 });
    return segs;
  }

  private eligible(): Network[] {
    return this.o.nets.usable().filter((n) => !this.dropped.has(n.id) && (!this.o.sources || this.o.sources[n.id]));
  }

  private perNet(net: Network): number {
    if (!this.o.ranges) return 1;
    return this.o.connectionsOverride && this.o.connectionsOverride > 0
      ? this.o.connectionsOverride
      : net.connections(this.o.connectionsPerNet());
  }

  private wantedTotal(): number {
    return this.eligible().reduce((a, n) => a + this.perNet(n), 0);
  }

  get downloaded(): number {
    return this.segments.reduce((a, s) => a + s.done, 0);
  }

  get activeConnections(): number {
    return this.segments.filter((s) => s.owner !== undefined).length;
  }

  private complete(): boolean {
    if (this.size < 0) return false;
    return this.segments.every((s) => s.end >= 0 && s.done >= s.end - s.start);
  }

  async run(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    const exists = fs.existsSync(this.o.file);
    this.fh = await fs.promises.open(this.o.file, exists ? "r+" : "w+");
    if (!exists && this.size > 0) {
      // Sparse: the file is full size, but disk space is only used as data arrives (on Windows this
      // needs a flag; macOS/Linux do it already). Drives without sparse support reserve it all up front.
      await makeSparse(this.o.file);
      await this.fh.truncate(this.size);
    }
    const onAbort = () => this.ctrl.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const done = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    const timer = setInterval(() => {
      // Deleted from outside Lanes (e.g. in File Explorer)? Stop, so the handle closes and Windows
      // frees the space — it can't while we keep writing into the deleted file.
      if (!fs.existsSync(this.o.file)) return this.fail(new FileGoneError());
      this.spawn();
    }, 1000);
    try {
      if (this.complete() || this.size === 0) this.finish();
      else this.spawn();
      await Promise.race([
        done,
        new Promise<never>((_, reject) =>
          this.ctrl.signal.addEventListener("abort", () => reject(this.ctrl.signal.reason ?? new Error("aborted")), { once: true }),
        ),
      ]);
      // finished faster than the once-a-second check could notice the file being deleted
      if (!fs.existsSync(this.o.file)) throw new FileGoneError();
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
      if (!this.ctrl.signal.aborted) this.ctrl.abort(new Error("finished"));
      await Promise.allSettled([...this.workers.values()].map((w) => w.p));
      for (const s of this.segments) {
        delete s.owner;
        delete s.net;
      }
      await this.fh.close().catch(() => {});
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.settle.resolve();
  }

  private fail(e: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.settle.reject(e);
  }

  /** Start workers so each eligible network runs its configured number of connections. */
  private spawn(): void {
    if (this.finished || this.ctrl.signal.aborted) return;
    const nets = this.eligible();
    if (!nets.length && !this.workers.size) {
      this.fail(this.dropped.size && this.lastError ? this.lastError : new NoNetworkError());
      return;
    }
    for (const net of nets) {
      const running = [...this.workers.values()].filter((w) => w.net === net.id).length;
      const want = this.perNet(net);
      for (let i = running; i < want; i++) {
        if (!this.o.ranges && this.workers.size >= 1) return;
        const id = this.nextWorker++;
        const p = this.worker(id, net).finally(() => {
          this.workers.delete(id);
          this.afterWorker();
        });
        this.workers.set(id, { net: net.id, p });
      }
    }
  }

  private afterWorker(): void {
    if (this.finished) return;
    if (this.complete()) return this.finish();
    if (!this.workers.size) {
      const nets = this.eligible();
      if (!nets.length) this.fail(this.dropped.size && this.lastError ? this.lastError : new NoNetworkError());
      // otherwise the supervisor timer will respawn
    }
  }

  private shouldStop(id: number, net: Network): boolean {
    if (this.ctrl.signal.aborted || this.finished) return true;
    if (!net.cfg.enabled || !net.present || this.dropped.has(net.id)) return true;
    // shed workers when the connection count was lowered
    const mine = [...this.workers.entries()].filter(([, w]) => w.net === net.id).map(([k]) => k).sort((a, b) => a - b);
    return mine.indexOf(id) >= this.perNet(net);
  }

  private async worker(id: number, net: Network): Promise<void> {
    let streak = 0;
    while (!this.shouldStop(id, net)) {
      const seg = this.claim(id, net);
      if (!seg) {
        if (this.complete()) return;
        if (!this.segments.some((s) => s.owner !== undefined)) return;
        try {
          await sleep(250, this.ctrl.signal);
        } catch {
          return;
        }
        continue;
      }
      try {
        await this.fetch(seg, net);
        streak = 0;
        this.failures.set(net.id, 0);
        if (this.complete()) return this.finish();
      } catch (e) {
        if (this.ctrl.signal.aborted || this.finished) return;
        const err = e instanceof Error ? e : new Error(String(e));
        if ((err as any).released) continue;
        this.lastError = err;
        streak++;
        const n = (this.failures.get(net.id) ?? 0) + 1;
        this.failures.set(net.id, n);
        // "this adapter can't reach that address" never fixes itself on retry: drop the network at once
        const unreachable = /^(EADDRNOTAVAIL|EINVAL|ENETUNREACH|EHOSTUNREACH|EAFNOSUPPORT)$/.test(String((err as NodeJS.ErrnoException).code ?? ""));
        if (n >= this.o.maxFailures || unreachable) {
          this.dropped.add(net.id);
          return;
        }
        try {
          await sleep(Math.min(8000, 600 * streak), this.ctrl.signal);
        } catch {
          return;
        }
      } finally {
        if (seg.owner === id) {
          delete seg.owner;
          delete seg.net;
        }
      }
    }
  }

  /** Take a free segment, or split the biggest busy one. */
  private claim(id: number, net: Network): LiveSegment | null {
    const free = this.segments
      .filter((s) => s.owner === undefined && (s.end < 0 || s.done < s.end - s.start))
      .sort((a, b) => a.start - b.start)[0];
    if (free) {
      if (!this.o.ranges && free.done > 0) free.done = 0; // cannot resume without ranges
      free.owner = id;
      free.net = net.id;
      return free;
    }
    if (!this.o.ranges || this.size < 0) return null;
    let best: LiveSegment | null = null;
    let bestLeft = 0;
    for (const s of this.segments) {
      if (s.owner === undefined) continue;
      const left = s.end - (s.start + s.done);
      if (left > bestLeft) {
        best = s;
        bestLeft = left;
      }
    }
    if (!best || bestLeft < this.o.minSegment * 2) return null;
    const cur = best.start + best.done;
    const mid = cur + Math.floor(bestLeft / 2);
    const seg: LiveSegment = { start: mid, end: best.end, done: 0, owner: id, net: net.id };
    best.end = mid;
    this.segments.splice(this.segments.indexOf(best) + 1, 0, seg);
    return seg;
  }

  private async fetch(seg: LiveSegment, net: Network): Promise<void> {
    const from = seg.start + seg.done;
    const headers = { ...this.o.headers };
    if (this.o.ranges) headers.Range = seg.end > 0 ? `bytes=${from}-${seg.end - 1}` : `bytes=${from}-`;
    const url = this.o.sources?.[net.id] ?? this.o.url;
    const { res } = await request(url, { net, headers, signal: this.ctrl.signal });
    const status = res.statusCode ?? 0;
    try {
      if (this.o.ranges) {
        if (status !== 206) throw new HttpError(status, status === 200 ? "Server ignored the byte range" : undefined);
        const m = /bytes\s+(\d+)-/i.exec(String(res.headers["content-range"] ?? ""));
        if (!m || Number(m[1]) !== from) throw new Error("Server returned the wrong byte range");
      } else if (status !== 200) {
        throw new HttpError(status);
      }

      for await (const chunk of res as AsyncIterable<Buffer>) {
        let off = 0;
        while (off < chunk.length) {
          if (seg.owner === undefined || this.shouldStopNow(net)) throw released();
          const piece = chunk.subarray(off, off + MAX_SLICE);
          await this.o.globalBucket.take(piece.length, this.ctrl.signal);
          await net.bucket.take(piece.length, this.ctrl.signal);
          // re-check the end after waiting: another worker may have split this segment
          const room = seg.end < 0 ? piece.length : seg.end - (seg.start + seg.done);
          const buf = room < piece.length ? piece.subarray(0, Math.max(0, room)) : piece;
          if (buf.length) {
            await this.fh.write(buf, 0, buf.length, seg.start + seg.done);
            seg.done += buf.length;
            this.o.onBytes(buf.length, net.id);
          }
          off += piece.length;
          if (seg.end >= 0 && seg.start + seg.done >= seg.end) return;
        }
      }
      if (seg.end < 0) {
        // unknown length: the server closing the stream is the end of the file
        seg.end = seg.start + seg.done;
        this.size = seg.end;
        return;
      }
      if (seg.start + seg.done < seg.end) throw new Error("Connection closed early");
    } finally {
      res.destroy();
    }
  }

  private shouldStopNow(net: Network): boolean {
    return this.ctrl.signal.aborted || !net.cfg.enabled || !net.present;
  }
}

function released(): Error {
  const e = new Error("released");
  (e as any).released = true;
  return e;
}

/** Collapse many tiny segments for display: at most `max` ranges. */
export function summarizeSegments(
  segs: { start: number; end: number; done: number; net?: string }[],
  size: number,
  max = 96,
): { start: number; end: number; done: number; net?: string }[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start).map((s) => ({ ...s, end: s.end < 0 ? Math.max(size, s.start + s.done) : s.end }));
  if (sorted.length <= max) return sorted;
  const out: typeof sorted = [];
  const per = Math.ceil(sorted.length / max);
  for (let i = 0; i < sorted.length; i += per) {
    const group = sorted.slice(i, i + per);
    out.push({
      start: group[0].start,
      end: group[group.length - 1].end,
      done: group.reduce((a, s) => a + s.done, 0),
      net: group.find((s) => s.net)?.net,
    });
  }
  return out;
}
