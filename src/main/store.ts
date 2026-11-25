import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { QueueDef, Settings } from "../shared/types.js";

export const MAIN_QUEUE: QueueDef = {
  id: "main",
  name: "Main queue",
  maxActive: 0,
  schedule: { enabled: false, start: "02:00", stop: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
  onComplete: "none",
};

export function defaultSettings(downloads = path.join(os.homedir(), "Downloads")): Settings {
  return {
    downloadDir: downloads,
    categorize: true,
    maxActive: 3,
    connectionsPerNetwork: 6,
    globalLimitKBps: 0,
    minSegmentKB: 512,
    retries: 6,
    autoResume: true,
    closeToTray: true,
    autoStart: true,
    autoUpdate: true,
    startMinimized: false,
    notifyComplete: true,
    clipboardWatch: true,
    duplicateAction: "ask",
    existingFileAction: "rename",
    autoHash: false,
    hashAlgo: "sha256",
    userAgent: "",
    apiPort: 6812,
    apiToken: "",
    intercept: true,
    interceptMinMB: 0,
    defaultQuality: "best",
    downloadDialog: true,
    cookiesFromBrowser: "",
    seedRatio: 0,
    theme: "glass",
    accent: "#4f8cff",
    glassTint: 55,
    refraction: true,
    compact: false,
    networks: [],
    queues: [structuredClone(MAIN_QUEUE)],
    rules: [],
    extensionDismissed: false,
    extensionBrowsers: [],
    welcomeShown: false,
  };
}

/** Atomic JSON write: temp file + rename, so a crash never leaves half a file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

/** Merge an untrusted patch onto settings, coercing every field to its type and range. */
export function sanitizeSettings(base: Settings, patch: Partial<Settings>): Settings {
  const d = defaultSettings();
  const s: Settings = { ...base };
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    if (!(key in d)) continue;
    const v = patch[key];
    const def = d[key];
    if (typeof def === "boolean") (s as any)[key] = !!v;
    else if (typeof def === "string") (s as any)[key] = typeof v === "string" ? v : def;
    else if (Array.isArray(def)) (s as any)[key] = Array.isArray(v) ? v : def;
    else if (typeof def === "number") (s as any)[key] = Number.isFinite(Number(v)) ? Number(v) : def;
  }
  s.maxActive = clamp(s.maxActive, 1, 32, d.maxActive);
  s.connectionsPerNetwork = clamp(s.connectionsPerNetwork, 1, 32, d.connectionsPerNetwork);
  s.globalLimitKBps = clamp(s.globalLimitKBps, 0, 10_000_000, 0);
  s.minSegmentKB = clamp(s.minSegmentKB, 64, 65536, d.minSegmentKB);
  s.retries = clamp(s.retries, 0, 50, d.retries);
  s.apiPort = clamp(s.apiPort, 1024, 65535, d.apiPort);
  s.interceptMinMB = clamp(s.interceptMinMB, 0, 100000, 0);
  s.glassTint = clamp(s.glassTint, 0, 100, d.glassTint);
  s.seedRatio = Math.max(0, Math.min(100, Number(s.seedRatio) || 0));
  if (!["glass", "dark", "light", "auto"].includes(s.theme)) s.theme = d.theme;
  if (!["ask", "rename", "skip", "overwrite"].includes(s.duplicateAction)) s.duplicateAction = d.duplicateAction;
  if (!["rename", "overwrite"].includes(s.existingFileAction)) s.existingFileAction = d.existingFileAction;
  if (!["sha256", "sha1", "md5", "sha512"].includes(s.hashAlgo)) s.hashAlgo = d.hashAlgo;
  if (!/^#[0-9a-f]{6}$/i.test(s.accent) || s.accent.toLowerCase() === "#7c6cff") s.accent = d.accent; // #7c6cff was the 1.0 default
  if (!s.queues.some((q) => q.id === "main")) s.queues = [structuredClone(MAIN_QUEUE), ...s.queues];
  s.queues = s.queues.map((q) => ({
    id: String(q.id || crypto.randomUUID()),
    name: String(q.name || "Queue").slice(0, 60),
    maxActive: clamp(q.maxActive, 0, 32, 0),
    schedule: {
      enabled: !!q.schedule?.enabled,
      start: /^\d\d:\d\d$/.test(q.schedule?.start) ? q.schedule.start : "02:00",
      stop: /^\d\d:\d\d$/.test(q.schedule?.stop) ? q.schedule.stop : "",
      days: Array.isArray(q.schedule?.days) ? q.schedule.days.filter((x) => x >= 0 && x <= 6) : [0, 1, 2, 3, 4, 5, 6],
    },
    onComplete: ["none", "quit", "sleep", "shutdown"].includes(q.onComplete) ? q.onComplete : "none",
  }));
  s.extensionBrowsers = [...new Set(s.extensionBrowsers.filter((b) => typeof b === "string").map((b) => b.slice(0, 20)))].slice(0, 8);
  s.rules = s.rules.map((r) => ({
    id: String(r.id || crypto.randomUUID()),
    enabled: r.enabled !== false,
    match: String(r.match || "").slice(0, 200),
    folder: String(r.folder || ""),
    category: (r.category || "") as any,
    queueId: String(r.queueId || ""),
    connections: clamp(r.connections, 0, 32, 0),
  }));
  return s;
}

export class SettingsStore {
  settings: Settings;
  /** @param downloads the system Downloads folder (Electron knows where Windows really keeps it) */
  constructor(
    private file: string,
    private downloads?: string,
  ) {
    const saved = readJson<Partial<Settings>>(file);
    this.settings = sanitizeSettings(defaultSettings(downloads), saved ?? {});
    if (!this.settings.downloadDir.trim()) this.settings.downloadDir = defaultSettings(downloads).downloadDir;
  }
  update(patch: Partial<Settings>): Settings {
    this.settings = sanitizeSettings(this.settings, patch);
    this.save();
    return this.settings;
  }
  reset(): Settings {
    const keep = { networks: this.settings.networks, queues: this.settings.queues, rules: this.settings.rules };
    this.settings = { ...defaultSettings(this.downloads), ...keep };
    this.save();
    return this.settings;
  }
  save(): void {
    writeJsonAtomic(this.file, this.settings);
  }
}
