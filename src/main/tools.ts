import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { request } from "./http.js";

const isWin = process.platform === "win32";

export function which(cmd: string): string | null {
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext.toLowerCase());
      const P = path.join(dir, cmd + ext);
      if (fs.existsSync(p)) return p;
      if (fs.existsSync(P)) return P;
    }
  }
  return null;
}

/** Locates yt-dlp and ffmpeg (bundled tools folder first, then PATH) and can install them. */
export class Tools {
  installing: string | null = null;
  message = "";
  constructor(private dir: string) {}

  private local(name: string): string {
    return path.join(this.dir, isWin ? `${name}.exe` : name);
  }

  get ytdlp(): string | null {
    const env = process.env.LANES_YTDLP;
    if (env && fs.existsSync(env)) return env;
    const l = this.local("yt-dlp");
    return fs.existsSync(l) ? l : which("yt-dlp");
  }

  get ffmpeg(): string | null {
    const env = process.env.LANES_FFMPEG;
    if (env && fs.existsSync(env)) return env;
    const l = this.local("ffmpeg");
    return fs.existsSync(l) ? l : which("ffmpeg");
  }

  /**
   * A JavaScript runtime yt-dlp can use for YouTube's challenges. Without deno or
   * node on PATH, Lanes's own executable runs as Node (ELECTRON_RUN_AS_NODE, see env).
   */
  get jsRuntime(): string | null {
    if (which("deno")) return null; // yt-dlp finds deno on its own
    const node = which("node");
    if (node) return `node:${node}`;
    return process.versions.electron ? `node:${process.execPath}` : null;
  }

  /** Extra environment for yt-dlp (lets the Electron binary stand in for node). */
  get env(): Record<string, string> {
    return process.versions.electron && !which("deno") && !which("node") ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  }

  /** Path to the tool, installing it first if needed (waits for an install already running). */
  async ensure(tool: "ytdlp" | "ffmpeg", onStatus: () => void): Promise<string> {
    const have = () => (tool === "ytdlp" ? this.ytdlp : this.ffmpeg);
    while (this.installing) await new Promise((r) => setTimeout(r, 400));
    if (!have()) await this.install(tool, onStatus);
    const p = have();
    if (!p) throw new Error(`Could not install ${tool}`);
    return p;
  }

  async install(tool: "ytdlp" | "ffmpeg", onStatus: () => void): Promise<void> {
    if (this.installing) throw new Error(`Already installing ${this.installing}`);
    this.installing = tool;
    this.message = "Downloading…";
    onStatus();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (tool === "ytdlp") {
        const asset = isWin ? "yt-dlp.exe" : process.platform === "darwin" ? "yt-dlp_macos" : "yt-dlp_linux";
        const dest = this.local("yt-dlp");
        await downloadTo(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, dest, (m) => {
          this.message = m;
          onStatus();
        });
        if (!isWin) fs.chmodSync(dest, 0o755);
      } else {
        if (!isWin) throw new Error("Install ffmpeg with your package manager (brew / apt), then restart Lanes.");
        const zip = path.join(this.dir, "ffmpeg.zip");
        await downloadTo(
          "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
          zip,
          (m) => {
            this.message = m;
            onStatus();
          },
        );
        this.message = "Extracting…";
        onStatus();
        const tmp = path.join(this.dir, "ffmpeg-extract");
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.mkdirSync(tmp, { recursive: true });
        // Windows' own bsdtar reads zips; a GNU tar earlier on PATH (e.g. from Git) can't
        const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
        const r = spawnSync(fs.existsSync(tar) ? tar : "tar", ["-xf", zip, "-C", tmp], { windowsHide: true });
        if (r.status !== 0) throw new Error("Could not extract ffmpeg: " + r.stderr?.toString());
        const found = findFile(tmp, "ffmpeg.exe");
        if (!found) throw new Error("ffmpeg.exe not found in the archive");
        fs.copyFileSync(found, this.local("ffmpeg"));
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(zip, { force: true });
      }
      this.message = "Installed";
    } catch (e) {
      this.message = (e as Error).message;
      throw e;
    } finally {
      this.installing = null;
      onStatus();
    }
  }
}

function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (entry.name.toLowerCase() === name) return p;
  }
  return null;
}

async function downloadTo(url: string, dest: string, onMsg: (m: string) => void): Promise<void> {
  const { res } = await request(url, { timeoutMs: 60_000 });
  if (res.statusCode !== 200) {
    res.destroy();
    throw new Error(`Download failed (HTTP ${res.statusCode})`);
  }
  const total = Number(res.headers["content-length"]) || 0;
  const tmp = dest + ".download";
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let last = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    got += chunk.length;
    if (Date.now() - last > 300) {
      last = Date.now();
      onMsg(total ? `Downloading… ${Math.round((got / total) * 100)}%` : `Downloading… ${(got / 1048576).toFixed(1)} MB`);
    }
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  fs.renameSync(tmp, dest);
}

/** Run a process, collect stdout, reject with stderr's last line on failure. */
export function run(
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; onStderr?: (line: string) => void; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...opts.env } });
    let out = "";
    let err = "";
    const kill = () => killTree(p.pid);
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null;
    opts.signal?.addEventListener("abort", kill, { once: true });
    if (opts.signal?.aborted) kill();
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => {
      err += d;
      if (opts.onStderr) for (const line of String(d).split(/\r?\n|\r/)) if (line.trim()) opts.onStderr(line);
    });
    p.on("error", (e) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      reject(e);
    });
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      if (opts.signal?.aborted) reject(new Error("stopped"));
      else if (code === 0) resolve(out);
      else {
        const lines = err.trim().split(/\r?\n/).filter((l) => /ERROR|error/i.test(l));
        reject(new Error((lines.pop() || err.trim().split(/\r?\n/).pop() || `exited with ${code}`).replace(/^ERROR:\s*/, "")));
      }
    });
  });
}

/** Kill a process and its children (yt-dlp.exe is a launcher with a child Python process). */
export function killTree(pid?: number): void {
  if (!pid) return;
  if (isWin) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
  else
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
}
