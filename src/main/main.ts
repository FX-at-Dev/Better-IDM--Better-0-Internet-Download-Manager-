import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type http from "node:http";
import crypto from "node:crypto";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray,
} from "electron";
import { SettingsStore } from "./store.js";
import { NetworkManager, idFor } from "./networks.js";
import { Tools } from "./tools.js";
import { Manager, type JobRecord } from "./manager.js";
import { startApi } from "./api.js";
import { categoryOf, filenameFromUrl, isMediaSite, looksDownloadable, pickFilename } from "./naming.js";
import { probe } from "./http.js";
import { probeMedia } from "./media.js";
import { readStoreIds, registerExternalExtensions, storeLinks } from "./stores.js";
import { shutdownTorrents, torrentAvailable } from "./torrent.js";
import type { AddOptions, AddRequest, AppState, ClipboardOffer, CompleteAction, Inspection, JobAction, NetworkConfig, Settings } from "../shared/types.js";

const isDev = !!process.env.LANES_DEV;
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const ASSETS = path.join(ROOT, "assets");

if (process.env.LANES_HOME) app.setPath("userData", process.env.LANES_HOME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
/**
 * Windows matches taskbar buttons to Start-menu shortcuts by this ID and shows that shortcut's icon.
 * Electron creates a shortcut for whatever exe is running when it first shows a notification, so dev
 * runs (electron.exe) and the portable .exe (a new temp folder each run) get their own IDs — otherwise
 * their shortcuts take over the installed app's taskbar icon. ("app.prism…" is kept for in-place upgrades.)
 */
const INSTALLED_AUMID = "app.prism.downloadmanager";
const AUMID = !app.isPackaged ? "app.lanes.dev" : process.env.PORTABLE_EXECUTABLE_FILE ? "app.lanes.portable" : INSTALLED_AUMID;
app.setAppUserModelId(AUMID);

const dataDir = app.getPath("userData");
fs.mkdirSync(dataDir, { recursive: true });
migrateFromPrism();

/**
 * Lanes was called Prism in 1.0.0. Carry its settings, download list, tools and torrents over once.
 * The browser extension has to be re-added from the new folder, so the setup page is shown again.
 */
function migrateFromPrism(): void {
  if (process.env.LANES_HOME) return;
  const old = path.join(app.getPath("appData"), "Prism");
  if (fs.existsSync(path.join(dataDir, "settings.json")) || !fs.existsSync(path.join(old, "settings.json"))) return;
  try {
    for (const name of ["settings.json", "jobs.json", "tools", "torrents"]) {
      const from = path.join(old, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dataDir, name), { recursive: true });
    }
    const file = path.join(dataDir, "settings.json");
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...s, welcomeShown: false, extensionBrowsers: [] }));
  } catch (e) {
    console.error("Could not carry over Prism's settings:", (e as Error).message);
  }
}
const store = new SettingsStore(path.join(dataDir, "settings.json"), app.getPath("downloads"));
const nets = new NetworkManager(
  () => store.settings,
  (n) => store.update({ networks: n }),
);
const tools = new Tools(path.join(dataDir, "tools"));
const STORE_IDS = readStoreIds(app.getAppPath());

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let api: http.Server | null = null;
let apiPort = 0;
let pending: { action: CompleteAction; at: number; queue: string; timer: NodeJS.Timeout } | null = null;

const manager = new Manager(dataDir, store, nets, tools, {
  onFinished: notifyFinished,
  onQueueDone: (q) => armCompleteAction(q.onComplete, q.name),
  trash: (f) => shell.trashItem(f),
});

/**
 * The unpacked extension, copied to a fixed place in the user's profile. Browsers load unpacked
 * extensions from a path, and the portable .exe unpacks to a new temp folder on every run.
 * The folder names are what people see when they drag the folder into the browser.
 */
let extDirCache = "";
function extensionDir(): string {
  if (extDirCache) return extDirCache;
  const src = app.isPackaged ? path.join(process.resourcesPath, "extension") : path.join(ROOT, "extension", "build");
  const dst = path.join(dataDir, "extension");
  try {
    fs.cpSync(path.join(src, "chrome"), path.join(dst, "Lanes Extension"), { recursive: true, force: true });
    fs.cpSync(path.join(src, "firefox"), path.join(dst, "Lanes Extension (Firefox)"), { recursive: true, force: true });
    for (const old of ["chrome", "firefox"]) fs.rmSync(path.join(dst, old), { recursive: true, force: true }); // pre-1.0 layout
    extDirCache = dst;
  } catch {
    extDirCache = src;
  }
  return extDirCache;
}
const chromiumExtDir = () => (fs.existsSync(path.join(extensionDir(), "Lanes Extension")) ? path.join(extensionDir(), "Lanes Extension") : path.join(extensionDir(), "chrome"));
const firefoxExtDir = () => (fs.existsSync(path.join(extensionDir(), "Lanes Extension (Firefox)")) ? path.join(extensionDir(), "Lanes Extension (Firefox)") : path.join(extensionDir(), "firefox"));

type SetupBrowser = "edge" | "chrome" | "brave" | "opera" | "firefox";

/**
 * Show the unpacked extension in a folder window, already selected so it can be dragged into the
 * browser's extensions page; its path is copied too, for "Load unpacked". (Browsers don't let other
 * programs open their extensions page — chrome://extensions passed on the command line opens a blank
 * tab — so the setup page has the user paste that address instead.)
 */
function openForSetup(browser: SetupBrowser): void {
  const target = browser === "firefox" ? path.join(firefoxExtDir(), "manifest.json") : chromiumExtDir();
  lastClip = target;
  clipboard.writeText(target);
  shell.showItemInFolder(target);
}

/** Open the extension setup page in the user's default browser. */
async function openSetupPage(): Promise<boolean> {
  if (!api || !apiPort) return false;
  await shell.openExternal(`http://127.0.0.1:${apiPort}/welcome`);
  return true;
}

function icon(name = "icon.png"): Electron.NativeImage {
  const p = path.join(ASSETS, name);
  return fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
}

// ------------------------------------------------------------------ window

function isDarkTheme(s: Settings): boolean {
  if (s.theme === "light") return false;
  if (s.theme === "auto") return nativeTheme.shouldUseDarkColors;
  return true;
}

function applyWindowTheme(): void {
  if (!win) return;
  const s = store.settings;
  const dark = isDarkTheme(s);
  nativeTheme.themeSource = s.theme === "auto" || s.theme === "glass" ? (s.theme === "glass" ? "dark" : "system") : s.theme;
  if (process.platform === "win32") {
    try {
      win.setBackgroundMaterial(s.theme === "glass" ? "acrylic" : "mica");
    } catch {}
    win.setTitleBarOverlay({ color: "#00000000", symbolColor: dark ? "#e8e8f0" : "#1c1c28", height: 44 });
  } else if (process.platform === "darwin") {
    win.setVibrancy(s.theme === "glass" ? "under-window" : null);
  }
}

function createWindow(show = true): void {
  const s = store.settings;
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: "Lanes",
    icon: icon(),
    backgroundColor: "#00000000",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay:
      process.platform === "darwin"
        ? undefined
        : { color: "#00000000", symbolColor: isDarkTheme(s) ? "#e8e8f0" : "#1c1c28", height: 44 },
    backgroundMaterial: process.platform === "win32" ? (s.theme === "glass" ? "acrylic" : "mica") : undefined,
    vibrancy: process.platform === "darwin" && s.theme === "glass" ? "under-window" : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  applyWindowTheme();
  win.setMenu(null);
  if (isDev) win.loadURL("http://localhost:5199");
  else win.loadFile(path.join(ROOT, "dist", "renderer", "index.html"));

  win.once("ready-to-show", () => {
    if (show) win?.show();
  });
  // dev aid: LANES_SNAP=<dir> runs LANES_SNAP/steps.json ([{name, js, wait}]) and saves a PNG per step
  if (process.env.LANES_SNAP) {
    const dir = process.env.LANES_SNAP;
    win.webContents.setBackgroundThrottling(false);
    const size = /^(\d+)x(\d+)$/.exec(process.env.LANES_SNAP_SIZE ?? "");
    if (size) win.setContentSize(Number(size[1]), Number(size[2]));
    win.webContents.once("did-finish-load", async () => {
      const steps: { name: string; js?: string; wait?: number }[] = JSON.parse(fs.readFileSync(path.join(dir, "steps.json"), "utf8"));
      for (const st of steps) {
        if (st.js)
          await win!.webContents
            .executeJavaScript(`(async()=>{try{${st.js}}catch(e){return 'ERR '+e.message}})()`)
            .then((r) => r && console.log("step", st.name, r))
            .catch((e) => console.error("step", st.name, e.message));
        await new Promise((r) => setTimeout(r, st.wait ?? 1500));
        win!.webContents.invalidate();
        await new Promise((r) => setTimeout(r, 120));
        const img = await win!.webContents.capturePage();
        fs.writeFileSync(path.join(dir, `${st.name}.png`), img.toPNG());
      }
      fs.writeFileSync(path.join(dir, "done"), "1");
    });
  }
  win.on("close", (e) => {
    if (!quitting && store.settings.closeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => (win = null));
  // keep navigation inside the app; open external links in the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("http://localhost:5199") && !url.startsWith("file:")) e.preventDefault();
  });
}

function showWindow(): void {
  if (!win) createWindow(true);
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

// ------------------------------------------------------------------ tray & notifications

function buildTray(): void {
  const img = icon("tray.png");
  tray = new Tray(img.isEmpty() ? icon() : img);
  tray.setToolTip("Lanes");
  tray.on("click", showWindow);
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const t = manager.totals();
  tray.setToolTip(t.active ? `Lanes — ${t.active} downloading, ${fmtSpeed(t.speed)}` : "Lanes");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Lanes", click: showWindow },
      { type: "separator" },
      { label: "Resume all", click: () => manager.resumeAll() },
      { label: "Pause all", click: () => manager.pauseAll() },
      { type: "separator" },
      { label: "Quit", click: () => void quit() },
    ]),
  );
}

function fmtSpeed(b: number): string {
  if (b < 1024) return `${b.toFixed(0)} B/s`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB/s`;
  return `${(b / 1048576).toFixed(1)} MB/s`;
}

function notifyFinished(job: JobRecord, ok: boolean): void {
  if (!store.settings.notifyComplete || !Notification.isSupported()) return;
  const mismatch = job.checksum?.state === "mismatch";
  const n = new Notification({
    title: ok ? (mismatch ? "Checksum mismatch" : "Download complete") : "Download failed",
    body: ok ? job.filename + (mismatch ? " — the file does not match the expected hash" : "") : `${job.filename}\n${job.error ?? ""}`,
    icon: icon(),
    silent: false,
  });
  n.on("click", () => {
    if (ok && job.path) shell.showItemInFolder(job.path);
    else showWindow();
  });
  n.show();
}

// ------------------------------------------------------------------ queue completion actions

function armCompleteAction(action: CompleteAction, queue: string): void {
  if (action === "none" || pending) return;
  const delay = action === "quit" ? 15_000 : 60_000;
  const timer = setTimeout(() => runCompleteAction(action), delay);
  pending = { action, at: Date.now() + delay, queue, timer };
  showWindow();
  pushState();
}

function cancelCompleteAction(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
  pushState();
}

function runCompleteAction(action: CompleteAction): void {
  pending = null;
  if (action === "quit") return void quit();
  if (process.platform === "win32") {
    if (action === "shutdown") spawn("shutdown", ["/s", "/t", "0"], { detached: true, windowsHide: true });
    if (action === "sleep") spawn("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], { detached: true, windowsHide: true });
  } else if (process.platform === "darwin") {
    spawn("osascript", ["-e", `tell app "System Events" to ${action === "sleep" ? "sleep" : "shut down"}`], { detached: true });
  } else {
    spawn("systemctl", [action === "sleep" ? "suspend" : "poweroff"], { detached: true });
  }
}

// ------------------------------------------------------------------ clipboard catcher

let lastClip = "";
function watchClipboard(): void {
  setInterval(async () => {
    if (!store.settings.clipboardWatch) return;
    let text = "";
    try {
      text = String(await clipboard.readText()).trim();
    } catch {
      return;
    }
    if (!text || text === lastClip) return;
    lastClip = text;
    const media = /^https?:\/\/\S+$/.test(text) && isMediaSite(text);
    if (text.length > 4000 || !(looksDownloadable(text) || media)) return;
    if ([...manager.jobs.values()].some((j) => j.url === text)) return;
    const offer: ClipboardOffer = {
      url: text,
      kind: text.startsWith("magnet:") || /\.torrent(\?|$)/i.test(text) ? "torrent" : media ? "media" : "http",
      name: text.startsWith("magnet:") ? decodeURIComponent(/dn=([^&]+)/.exec(text)?.[1] ?? "Magnet link").replace(/\+/g, " ") : (filenameFromUrl(text) ?? text),
    };
    if (win && win.isVisible() && !win.isMinimized()) win.webContents.send("clipboard", offer);
    else if (Notification.isSupported()) {
      const n = new Notification({ title: "Download copied link?", body: offer.name, icon: icon() });
      n.on("click", () => askAdd({ urls: [offer.url], source: "clipboard" }));
      n.show();
    }
  }, 900);
}

// ------------------------------------------------------------------ API server

async function restartApi(): Promise<void> {
  const port = store.settings.apiPort;
  if (api && apiPort === port) return;
  if (api) await new Promise((r) => api!.close(() => r(null)));
  api = null;
  try {
    api = await startApi(
      {
        version: app.getVersion(),
        settings: () => store.settings,
        add: (o) => {
          const r = manager.add(o);
          if (r.added.length && win?.isVisible()) win.webContents.send("flash", r.added);
          return r;
        },
        ask: askAdd,
        show: showWindow,
        extensionSeen: (browser) => {
          if (store.settings.extensionBrowsers.includes(browser)) return;
          store.update({ extensionBrowsers: [...store.settings.extensionBrowsers, browser] });
          pushState();
        },
        extensionPaths: () => ({ chrome: chromiumExtDir(), firefox: path.join(firefoxExtDir(), "manifest.json") }),
        storeLinks: () => storeLinks(STORE_IDS),
        openForSetup: (_action, browser) => openForSetup(browser as SetupBrowser),
      },
      port,
    );
    apiPort = port;
  } catch (e) {
    console.error("API server failed:", (e as Error).message);
    apiPort = 0;
  }
}

/** Bring the window up with the New download dialog for these links. */
function askAdd(r: AddRequest): void {
  showWindow();
  // Windows won't let a background app take focus from the browser; on top for a moment does it
  if (win) {
    win.setAlwaysOnTop(true);
    win.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
    setTimeout(() => win?.setAlwaysOnTop(false), 400);
  }
  const send = () => win?.webContents.send("focus-add", r);
  if (win?.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}

// ------------------------------------------------------------------ link inspection (New download dialog)

const inspectCache = new Map<string, { at: number; r: Inspection }>();

async function inspect(url: string, h: { cookie?: string; referer?: string; ua?: string } = {}): Promise<Inspection> {
  url = String(url || "").trim();
  if (/^magnet:\?/i.test(url)) {
    const dn = /[?&]dn=([^&]+)/.exec(url)?.[1];
    return { kind: "torrent", name: dn ? decodeURIComponent(dn.replace(/\+/g, " ")) : "Magnet link" };
  }
  if (!/^https?:\/\//i.test(url)) return { kind: "error", message: "That isn't a web link." };
  if (/\.torrent(\?|#|$)/i.test(url)) return { kind: "torrent", name: filenameFromUrl(url) ?? "Torrent" };
  const hit = inspectCache.get(url);
  if (hit && Date.now() - hit.at < 120_000) return hit.r;

  // Link checks use Windows' normal route; the per-network work happens when the download runs.
  const headers: Record<string, string> = {};
  if (h.cookie) headers.Cookie = h.cookie;
  if (h.referer) headers.Referer = h.referer;
  if (h.ua || store.settings.userAgent) headers["User-Agent"] = h.ua || store.settings.userAgent;
  let page = isMediaSite(url);
  let httpError = "";
  if (!page) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const p = await probe(url, { headers, signal: ctrl.signal });
      if (/text\/html|application\/xhtml/i.test(p.contentType ?? "")) page = true;
      else {
        const name = pickFilename({ disposition: p.disposition, url: p.finalUrl, contentType: p.contentType });
        return { kind: "file", url, name, size: p.size, type: p.contentType ?? "", resumable: p.ranges, category: categoryOf(name) };
      }
    } catch (e) {
      httpError = friendlyError((e as Error).message || "The server didn't answer");
      page = true; // some sites refuse plain requests but work through yt-dlp
    } finally {
      clearTimeout(t);
    }
  }
  if (!tools.ytdlp) return httpError ? { kind: "error", message: httpError, canDownloadAnyway: true } : { kind: "needs-ytdlp", site: hostOf(url) };
  try {
    const info = await probeMedia(tools, url, null, store.settings.cookiesFromBrowser);
    const r: Inspection = { kind: "media", info };
    inspectCache.set(url, { at: Date.now(), r });
    return r;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/unsupported url|no video|no media|unable to extract|no suitable/i.test(msg))
      return { kind: "error", message: httpError || "No video or downloadable file was found at this link.", canDownloadAnyway: true };
    if (/sign in|log(ged)?[- ]?in|cookies|private|members|age/i.test(msg))
      return { kind: "error", message: "This video needs you to be signed in. Turn on “Use cookies from browser” in Settings → Video sites, then try again." };
    return { kind: "error", message: friendlyError(msg) || "Could not read this link", canDownloadAnyway: true };
  }
}

/** Turn yt-dlp / socket errors into one readable sentence. */
function friendlyError(msg: string): string {
  if (/failed to establish|unreachable|getaddrinfo|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out|10051|10060|10065/i.test(msg))
    return "Couldn't reach the site. Check your internet connection and try again.";
  if (/HTTP Error 404|HTTP 404|not found/i.test(msg)) return "The page or file wasn't found (404).";
  if (/HTTP Error 403|HTTP 403|forbidden/i.test(msg)) return "The site refused the request (403).";
  if (/HTTP Error 429|too many requests/i.test(msg)) return "The site is rate-limiting requests. Wait a minute and try again.";
  const clean = msg
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, "")
    .replace(/\s*\(caused by[\s\S]*$/i, "")
    .replace(/;?\s*please report this issue[\s\S]*$/i, "")
    .trim();
  return clean.length > 220 ? clean.slice(0, 217) + "…" : clean;
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ state

function state(): AppState {
  return {
    version: app.getVersion(),
    platform: process.platform,
    settings: store.settings,
    jobs: manager.views(),
    networks: nets.views(store.settings.connectionsPerNetwork),
    totals: manager.totals(),
    tools: {
      ytdlp: tools.ytdlp,
      ffmpeg: tools.ffmpeg,
      torrent: torrentAvailable(),
      installing: tools.installing,
      message: tools.message,
    },
    apiListening: !!api,
    extensionDir: extensionDir(),
    pendingShutdown: pending ? { action: pending.action, at: pending.at, queue: pending.queue } : undefined,
  };
}

function pushState(): void {
  if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) win.webContents.send("state", state());
}

// ------------------------------------------------------------------ argv (urls, magnets, .torrent files)

function handleArgv(argv: string[]): void {
  const urls: string[] = [];
  for (const a of argv.slice(1)) {
    if (/^(https?:|magnet:)/i.test(a)) urls.push(a);
    else if (/\.torrent$/i.test(a) && fs.existsSync(a)) manager.addTorrentFile(fs.readFileSync(a), path.basename(a), { source: "cli" });
  }
  if (urls.length) manager.add({ urls, source: "cli", allowDuplicates: true });
}

// ------------------------------------------------------------------ IPC

function registerIpc(): void {
  ipcMain.handle("state", () => state());
  ipcMain.handle("inspect", (_e, url: string, h?: { cookie?: string; referer?: string; ua?: string }) => inspect(url, h ?? {}));
  ipcMain.handle("add", (_e, o: AddOptions) => {
    const r = manager.add({ ...o, source: "ui" });
    pushState();
    return r;
  });
  ipcMain.handle("addTorrentFile", (_e, p: string, o?: Partial<AddOptions>) => {
    if (!/\.torrent$/i.test(p) || !fs.existsSync(p)) return { added: [], duplicates: [], errors: ["Not a .torrent file"] };
    return manager.addTorrentFile(fs.readFileSync(p), path.basename(p), o);
  });
  ipcMain.handle("action", async (_e, ids: string[], action: JobAction) => {
    if (action === "open" || action === "reveal" || action === "copyUrl") {
      for (const id of ids) {
        const j = manager.jobs.get(id);
        if (!j) continue;
        if (action === "copyUrl") clipboard.writeText(j.url), (lastClip = j.url);
        else if (action === "open" && j.path && fs.existsSync(j.path)) shell.openPath(j.path);
        else if (j.path && fs.existsSync(j.path)) shell.showItemInFolder(j.path);
        else if (fs.existsSync(j.dir)) shell.openPath(j.dir);
      }
      return;
    }
    await manager.action(ids, action);
    pushState();
  });
  ipcMain.handle("moveToQueue", (_e, ids: string[], q: string) => manager.moveToQueue(ids, q));
  ipcMain.handle("setChecksum", (_e, id: string, algo, expected: string) => manager.setChecksum(id, algo, expected));
  ipcMain.handle("setSettings", async (_e, patch: Partial<Settings>) => {
    const before = store.settings;
    const s = store.update(patch);
    if (s.theme !== before.theme) applyWindowTheme();
    if (s.autoStart !== before.autoStart) applyAutoStart(s.autoStart);
    if (s.apiPort !== before.apiPort) await restartApi();
    if (patch.networks || patch.queues) {
      nets.refresh();
      manager.schedule();
    }
    pushState();
    return s;
  });
  ipcMain.handle("resetSettings", () => {
    const s = store.reset();
    applyWindowTheme();
    pushState();
    return s;
  });
  ipcMain.handle("addNetwork", (_e, name: string, address: string) => {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) throw new Error("Enter an IPv4 address like 192.168.1.20");
    const cfg: NetworkConfig = {
      id: idFor("custom-" + address),
      name: name || address,
      address,
      enabled: true,
      custom: true,
      connections: 0,
      limitKBps: 0,
    };
    store.update({ networks: [...store.settings.networks.filter((n) => n.id !== cfg.id), cfg] });
    nets.refresh();
  });
  ipcMain.handle("removeNetwork", (_e, id: string) => {
    store.update({ networks: store.settings.networks.filter((n) => n.id !== id) });
    nets.refresh();
  });
  ipcMain.handle("updateNetwork", (_e, id: string, patch: Partial<NetworkConfig>) => {
    store.update({
      networks: store.settings.networks.map((n) =>
        n.id === id
          ? {
              ...n,
              enabled: patch.enabled ?? n.enabled,
              name: typeof patch.name === "string" && patch.name.trim() ? patch.name.trim().slice(0, 40) : n.name,
              connections: patch.connections !== undefined ? Math.max(0, Math.min(32, Math.round(patch.connections))) : n.connections,
              limitKBps: patch.limitKBps !== undefined ? Math.max(0, Math.round(patch.limitKBps)) : n.limitKBps,
            }
          : n,
      ),
    });
    nets.refresh();
    manager.schedule();
  });
  ipcMain.handle("pauseAll", () => manager.pauseAll());
  ipcMain.handle("resumeAll", () => manager.resumeAll());
  ipcMain.handle("clearCompleted", () => manager.clearCompleted());
  ipcMain.handle("pickFolder", async (_e, current?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], defaultPath: current });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("pickTorrent", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters: [{ name: "Torrent", extensions: ["torrent"] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("installTool", async (_e, t: "ytdlp" | "ffmpeg") => {
    await tools.install(t, pushState).catch(() => {});
    pushState();
  });
  ipcMain.handle("openExtensionFolder", (_e, browser?: string) => {
    const b = (["edge", "chrome", "brave", "opera", "firefox"].includes(browser ?? "") ? browser : "chrome") as SetupBrowser;
    openForSetup(b);
  });
  ipcMain.handle("openSetupPage", () => openSetupPage());
  ipcMain.handle("cancelShutdown", () => cancelCompleteAction());
  ipcMain.handle("openPath", (_e, p: string) => {
    if (typeof p === "string" && fs.existsSync(p)) shell.openPath(p);
  });
  ipcMain.handle("newToken", () => {
    const t = crypto.randomBytes(16).toString("hex");
    store.update({ apiToken: t });
    pushState();
    return t;
  });
  ipcMain.on("window", (_e, cmd: string) => {
    if (!win) return;
    if (cmd === "minimize") win.minimize();
    else if (cmd === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (cmd === "close") win.close();
  });
}

// ------------------------------------------------------------------ lifecycle

async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  await manager.shutdown();
  await shutdownTorrents().catch(() => {});
  tray?.destroy();
  app.quit();
}

app.on("second-instance", (_e, argv) => {
  handleArgv(argv);
  showWindow();
});

app.on("before-quit", (e) => {
  if (!quitting) {
    e.preventDefault();
    void quit();
  }
});

app.on("window-all-closed", () => {
  if (!store.settings.closeToTray) void quit();
});

/**
 * Start Lanes (quietly, in the tray) when the user signs in, so browser downloads are caught from the
 * first minute. Re-applied on every launch, which also keeps the path right if the portable .exe moves.
 */
function applyAutoStart(on: boolean): void {
  if (!app.isPackaged) return; // dev builds never register
  // the portable .exe runs from a temporary folder; register the .exe the user actually has
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;
  try {
    if (process.platform === "win32") {
      app.setLoginItemSettings({ openAtLogin: on, path: exe, args: ["--hidden"], name: "Lanes" });
    } else if (process.platform === "darwin") {
      app.setLoginItemSettings({ openAtLogin: on }); // macOS passes no args; see openedAtLogin()
    } else {
      // Linux: XDG autostart entry
      const file = path.join(app.getPath("home"), ".config", "autostart", "lanes.desktop");
      if (on) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Lanes\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`);
      } else fs.rmSync(file, { force: true });
    }
  } catch (e) {
    console.error("Could not update start-with-computer:", (e as Error).message);
  }
}

app.whenReady().then(async () => {
  applyAutoStart(store.settings.autoStart);
  removeStrayShortcuts();
  nets.refresh();
  manager.load();
  registerIpc();
  const hidden = process.argv.includes("--hidden") || openedAtLogin() || store.settings.startMinimized;
  createWindow(!hidden);
  buildTray();
  await restartApi();
  extensionDir();
  registerExternalExtensions(STORE_IDS); // no-op until the extension is published
  // First launch after installing: open the extension setup page in the default browser.
  if (!store.settings.welcomeShown && !process.env.LANES_SNAP && !process.argv.includes("--hidden")) {
    store.update({ welcomeShown: true });
    if (!store.settings.extensionBrowsers.length) setTimeout(() => void openSetupPage(), 1500);
  }
  watchClipboard();
  handleArgv(process.argv);
  manager.schedule();

  setInterval(() => manager.tick(), 250);
  setInterval(pushState, 500);
  setInterval(updateTrayMenu, 3000);
  setInterval(() => nets.refresh(), 5000);
  nativeTheme.on("updated", () => {
    applyWindowTheme();
    pushState();
  });
});

/** macOS can't pass --hidden to login items; ask the OS instead. */
function openedAtLogin(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch {
    return false;
  }
}

/**
 * Remove Start-menu shortcuts that carry the installed app's ID but point somewhere else — Electron
 * made them for dev runs (electron.exe) and for 1.0–1.1.1 portable runs (a temp folder that's since
 * gone). Windows was showing their icon (Electron's) on the installed app's taskbar button.
 * Only shortcuts with our exact ID are ever touched.
 */
function removeStrayShortcuts(): void {
  if (process.platform !== "win32" || AUMID !== INSTALLED_AUMID || !app.isPackaged) return;
  const dir = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".lnk"));
  } catch {
    return;
  }
  const me = process.execPath.toLowerCase();
  for (const f of files) {
    const file = path.join(dir, f);
    try {
      const link = shell.readShortcutLink(file);
      if (link.appUserModelId !== INSTALLED_AUMID) continue;
      const target = (link.target || "").toLowerCase();
      if (target === me) continue;
      const name = path.basename(target);
      const inTemp = target.split(path.sep).includes("temp");
      const stray = !target || !fs.existsSync(link.target) || name === "electron.exe" || inTemp;
      if (stray) fs.rmSync(file, { force: true });
    } catch {}
  }
}
