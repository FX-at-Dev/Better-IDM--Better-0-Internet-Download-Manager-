// Types shared by the main process (engine) and the renderer (UI).

export type JobKind = "http" | "media" | "torrent";

export type JobStatus =
  | "queued" // waiting for a free slot
  | "scheduled" // waiting for its queue's time window
  | "probing" // asking the server about the file / resolving the video
  | "downloading"
  | "paused"
  | "merging" // joining video + audio
  | "verifying" // hashing the finished file
  | "seeding"
  | "completed"
  | "failed";

export type Category =
  | "video"
  | "audio"
  | "documents"
  | "archives"
  | "programs"
  | "images"
  | "torrents"
  | "other";

export const CATEGORIES: Category[] = [
  "video",
  "audio",
  "documents",
  "archives",
  "programs",
  "images",
  "torrents",
  "other",
];

/** Subfolder of the download folder for each category. Unknown types go to "Others". */
export const CATEGORY_FOLDER: Record<Category, string> = {
  video: "Videos",
  audio: "Music",
  documents: "Documents",
  archives: "Compressed",
  programs: "Programs",
  images: "Images",
  torrents: "Torrents",
  other: "Others",
};

export type HashAlgo = "sha256" | "sha1" | "md5" | "sha512";

export interface ChecksumState {
  algo: HashAlgo;
  expected?: string;
  actual?: string;
  /** pending = not computed yet, ok/mismatch = compared to expected, computed = no expected value */
  state: "pending" | "running" | "ok" | "mismatch" | "computed" | "error";
  progress?: number;
}

/** A byte range of the file. `end` is exclusive. */
export interface SegmentView {
  start: number;
  end: number;
  done: number;
  net?: string; // network currently pulling this segment
}

export interface NetShare {
  bytes: number;
  speed: number;
}

export interface JobView {
  id: string;
  kind: JobKind;
  url: string;
  filename: string;
  dir: string;
  path: string;
  category: Category;
  queueId: string;
  status: JobStatus;
  error?: string;
  note?: string; // transient progress note, e.g. "Installing ffmpeg…"
  size: number; // -1 = unknown
  downloaded: number;
  speed: number;
  eta: number; // seconds, -1 = unknown
  resumable: boolean;
  createdAt: number;
  completedAt?: number;
  connections: number;
  segments: SegmentView[];
  perNet: Record<string, NetShare>;
  history: number[]; // recent speed samples (bytes/s), one per second
  checksum?: ChecksumState;
  media?: { quality: string; label?: string; title?: string; parts: number; partIndex: number; stream?: boolean; thumbnail?: string };
  torrent?: {
    infoHash?: string;
    peers: number;
    uploaded: number;
    upSpeed: number;
    ratio: number;
    files: number;
  };
  order: number;
}

export interface NetworkView {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  present: boolean; // interface currently exists on the system
  custom: boolean;
  connections: number;
  limitKBps: number; // 0 = unlimited
  speed: number;
  sessionBytes: number;
  history: number[];
  color: string;
}

export type CompleteAction = "none" | "quit" | "sleep" | "shutdown";

export interface QueueDef {
  id: string;
  name: string;
  maxActive: number; // 0 = use the global limit
  schedule: {
    enabled: boolean;
    start: string; // "HH:MM"
    stop: string; // "" = run until empty
    days: number[]; // 0 = Sunday
  };
  onComplete: CompleteAction;
}

export interface SiteRule {
  id: string;
  enabled: boolean;
  match: string; // host glob, e.g. "*.github.com" or "example.org"
  folder: string; // "" = default
  category: Category | "";
  queueId: string; // "" = default
  connections: number; // 0 = default
}

export type ThemeName = "glass" | "dark" | "light" | "auto";

export interface Settings {
  downloadDir: string;
  categorize: boolean;
  maxActive: number;
  connectionsPerNetwork: number;
  globalLimitKBps: number;
  minSegmentKB: number;
  retries: number;
  autoResume: boolean;
  closeToTray: boolean;
  /** start (quietly, in the tray) when the user signs in to the computer */
  autoStart: boolean;
  startMinimized: boolean;
  notifyComplete: boolean;
  clipboardWatch: boolean;
  duplicateAction: "ask" | "rename" | "skip" | "overwrite";
  existingFileAction: "rename" | "overwrite";
  autoHash: boolean;
  hashAlgo: HashAlgo;
  userAgent: string;
  // browser integration
  apiPort: number;
  apiToken: string;
  intercept: boolean;
  interceptMinMB: number;
  // media / torrents
  defaultQuality: string;
  /** Show the download dialog before a file caught from the browser starts (videos always ask for a quality). */
  downloadDialog: boolean;
  cookiesFromBrowser: string;
  seedRatio: number;
  // look
  theme: ThemeName;
  accent: string;
  glassTint: number; // 0..100, how much of the backdrop shows through
  refraction: boolean;
  compact: boolean;
  // misc
  networks: NetworkConfig[];
  queues: QueueDef[];
  rules: SiteRule[];
  extensionDismissed: boolean;
  /** browsers the extension has checked in from, e.g. ["Edge"] */
  extensionBrowsers: string[];
  /** the setup page has been opened once (first launch) */
  welcomeShown: boolean;
}

export interface NetworkConfig {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
  custom: boolean;
  connections: number; // 0 = use the default
  limitKBps: number;
}

export interface ToolsInfo {
  ytdlp: string | null;
  ffmpeg: string | null;
  torrent: boolean;
  installing: string | null;
  message?: string;
}

export interface Totals {
  speed: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  history: number[];
}

export interface AppState {
  version: string;
  platform: string;
  settings: Settings;
  jobs: JobView[];
  networks: NetworkView[];
  totals: Totals;
  tools: ToolsInfo;
  apiListening: boolean;
  extensionDir: string;
  pendingShutdown?: { action: CompleteAction; at: number; queue: string };
}

/** One downloadable quality of a video, as offered in the quality picker. */
export interface MediaOption {
  id: string;
  /** yt-dlp format spec, e.g. "137+140" */
  format: string;
  label: string; // "1080p60", "Audio"
  detail: string; // "MP4 · H.264"
  height: number; // 0 = audio only
  ext: string; // container of the finished file
  size: number; // bytes, -1 = unknown
  audioOnly: boolean;
  /** joining video + audio or converting to MP3 needs ffmpeg */
  needsFfmpeg: boolean;
  /** HLS/DASH: yt-dlp downloads it itself, over one network */
  stream: boolean;
  convert?: "mp3";
}

export interface MediaInfo {
  url: string;
  title: string;
  site: string;
  uploader?: string;
  duration?: number; // seconds
  thumbnail?: string;
  options: MediaOption[];
  playlist?: { count: number; entries: string[] };
}

/** What a pasted link turned out to be. */
export type Inspection =
  | { kind: "file"; url: string; name: string; size: number; type: string; resumable: boolean; category: Category }
  | { kind: "media"; info: MediaInfo }
  | { kind: "torrent"; name: string }
  | { kind: "needs-ytdlp"; site: string }
  | { kind: "error"; message: string; canDownloadAnyway?: boolean };

/** The choice made in the quality picker, carried into the job. */
export interface MediaChoice {
  format: string;
  label: string;
  height: number;
  ext: string;
  stream: boolean;
  audioOnly: boolean;
  convert?: "mp3";
  size?: number;
  title?: string;
  thumbnail?: string;
}

/** A link handed to the New download dialog (from the extension, clipboard, argv…). */
export interface AddRequest {
  urls: string[];
  media?: boolean;
  filename?: string;
  cookie?: string;
  referer?: string;
  ua?: string;
  source?: AddOptions["source"];
}

export interface AddOptions {
  urls: string[];
  media?: boolean;
  quality?: string;
  format?: MediaChoice;
  dir?: string;
  filename?: string;
  queueId?: string;
  paused?: boolean;
  connections?: number;
  checksum?: { algo: HashAlgo; value: string };
  cookie?: string;
  referer?: string;
  ua?: string;
  allowDuplicates?: boolean;
  source?: "ui" | "extension" | "clipboard" | "cli";
}

export interface AddResult {
  added: string[];
  duplicates: { url: string; existingId: string; filename: string }[];
  errors: string[];
}

export type JobAction =
  | "pause"
  | "resume"
  | "cancel"
  | "remove"
  | "delete" // remove + delete file
  | "retry"
  | "restart"
  | "open"
  | "reveal"
  | "verify"
  | "copyUrl"
  | "top"
  | "bottom";

export interface ClipboardOffer {
  url: string;
  kind: JobKind;
  name: string;
}

export interface LanesApi {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): () => void;
  onClipboard(cb: (o: ClipboardOffer) => void): () => void;
  onFocusAdd(cb: (r: AddRequest) => void): () => void;
  inspect(url: string, headers?: { cookie?: string; referer?: string; ua?: string }): Promise<Inspection>;
  add(opts: AddOptions): Promise<AddResult>;
  addTorrentFile(path: string, opts?: { dir?: string; queueId?: string }): Promise<AddResult>;
  action(ids: string[], action: JobAction, arg?: string): Promise<void>;
  moveToQueue(ids: string[], queueId: string): Promise<void>;
  setChecksum(id: string, algo: HashAlgo, expected: string): Promise<void>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  resetSettings(): Promise<Settings>;
  addNetwork(name: string, address: string): Promise<void>;
  removeNetwork(id: string): Promise<void>;
  updateNetwork(id: string, patch: Partial<NetworkConfig>): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  clearCompleted(): Promise<void>;
  pickFolder(current?: string): Promise<string | null>;
  pickTorrent(): Promise<string | null>;
  installTool(tool: "ytdlp" | "ffmpeg"): Promise<void>;
  openExtensionFolder(browser?: "edge" | "chrome" | "firefox"): Promise<void>;
  /** open the extension setup page in the default browser */
  openSetupPage(): Promise<boolean>;
  cancelShutdown(): Promise<void>;
  openPath(p: string): Promise<void>;
  newToken(): Promise<string>;
  windowControl(cmd: "minimize" | "maximize" | "close"): void;
  pathForFile(f: File): string;
}
