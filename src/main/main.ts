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
import { Tools, which } from "./tools.js";
import { Manager, type JobRecord } from "./manager.js";
import { startApi } from "./api.js";
import { categoryOf, filenameFromUrl, isMediaSite, looksDownloadable, pickFilename } from "./naming.js";
import { probe } from "./http.js";
import { probeMedia } from "./media.js";
import { readStoreIds, registerExternalExtensions, storeLinks } from "./stores.js";
import { shutdownTorrents, torrentAvailable } from "./torrent.js";
import type { AddOptions, AddRequest, AppState, ClipboardOffer, CompleteAction, Inspection, JobAction, NetworkConfig, Settings } from "../shared/types.js";

const isDev = !!process.env.PRISM_DEV;
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const ASSETS = path.join(ROOT, "assets");

if (process.env.PRISM_HOME) app.setPath("userData", process.env.PRISM_HOME);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId("app.prism.downloadmanager");

const dataDir = app.getPath("userData");
fs.mkdirSync(dataDir, { recursive: true });
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
    fs.cpSync(path.join(src, "chrome"), path.join(dst, "Prism Extension"), { recursive: true, force: true });
    fs.cpSync(path.join(src, "firefox"), path.join(dst, "Prism Extension (Firefox)"), { recursive: true, force: true });
    for (const old of ["chrome", "firefox"]) fs.rmSync(path.join(dst, old), { recursive: true, force: true }); // pre-1.0 layout
    extDirCache = dst;
  } catch {
    extDirCache = src;
  }
  return extDirCache;
}
const chromiumExtDir = () => (fs.existsSync(path.join(extensionDir(), "Prism Extension")) ? path.join(extensionDir(), "Prism Extension") : path.join(extensionDir(), "chrome"));
const firefoxExtDir = () => (fs.existsSync(path.join(extensionDir(), "Prism Extension (Firefox)")) ? path.join(extensionDir(), "Prism Extension (Firefox)") : path.join(extensionDir(), "firefox"));

type SetupBrowser = "edge" | "chrome" | "brave" | "opera" | "firefox";
const BROWSER_EXE: Record<SetupBrowser, string> = { edge: "msedge", chrome: "chrome", brave: "brave", opera: "opera", firefox: "firefox" };
const MAC_APP: Record<SetupBrowser, string> = { edge: "Microsoft Edge", chrome: "Google Chrome", brave: "Brave Browser", opera: "Opera", firefox: "Firefox" };
const LINUX_EXE: Record<SetupBrowser, string[]> = {
  edge: ["microsoft-edge", "microsoft-edge-stable"],
  chrome: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
  brave: ["brave-browser", "brave"],
  opera: ["opera"],
  firefox: ["firefox"],
};

/** Browsers refuse to open their internal pages from a web link, but accept them when launched with one. */
function openInBrowser(browser: SetupBrowser, url: string): void {
  const opts = { detached: true, stdio: "ignore" as const, windowsHide: true };
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", BROWSER_EXE[browser], url], opts).unref();
  else if (process.platform === "darwin") spawn("open", ["-a", MAC_APP[browser], url], opts).unref();
  else {
    const exe = LINUX_EXE[browser].map((e) => which(e)).find(Boolean);
    if (exe) spawn(exe, [url], opts).on("error", () => {}).unref();
  }
}
const EXTENSIONS_PAGE: Record<SetupBrowser, string> = {
  edge: "edge://extensions",
  chrome: "chrome://extensions",
  brave: "brave://extensions",
  opera: "opera://extensions",
  firefox: "about:debugging#/runtime/this-firefox",
};

/**
 * Help with loading the unpacked extension: open the browser's extensions page, and/or a folder
 * window with the extension folder highlighted (ready to drag in). The path is copied too.
 */
function openForSetup(action: "folder" | "extensions" | "both", browser: SetupBrowser): void {
  if (action !== "folder") openInBrowser(browser, EXTENSIONS_PAGE[browser]);
  if (action !== "extensions") {
    const target = browser === "firefox" ? path.join(firefoxExtDir(), "manifest.json") : chromiumExtDir();
    lastClip = target;
    clipboard.writeText(target); // pasted into "Load unpacked" (folder) or Firefox's file picker (manifest.json)
    setTimeout(() => shell.showItemInFolder(target), action === "both" ? 700 : 0);
  }
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
    title: "Prism",
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
  // dev aid: PRISM_SNAP=<dir> runs PRISM_SNAP/steps.json ([{name, js, wait}]) and saves a PNG per step
  if (process.env.PRISM_SNAP) {
    const dir = process.env.PRISM_SNAP;
    win.webContents.setBackgroundThrottling(false);
    const size = /^(\d+)x(\d+)$/.exec(process.env.PRISM_SNAP_SIZE ?? "");
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
  tray.setToolTip("Prism");
  tray.on("click", showWindow);
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  const t = manager.totals();
  tray.setToolTip(t.active ? `Prism — ${t.active} downloading, ${fmtSpeed(t.speed)}` : "Prism");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Prism", click: showWindow },
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
        openForSetup: (action, browser) => openForSetup(action, browser as SetupBrowser),
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
    if (s.startAtLogin !== before.startAtLogin && app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: ["--hidden"] });
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
    openForSetup("both", b);
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

app.whenReady().then(async () => {
  nets.refresh();
  manager.load();
  registerIpc();
  const hidden = process.argv.includes("--hidden") || store.settings.startMinimized;
  createWindow(!hidden);
  buildTray();
  await restartApi();
  extensionDir();
  registerExternalExtensions(STORE_IDS); // no-op until the extension is published
  // First launch after installing: open the extension setup page in the default browser.
  if (!store.settings.welcomeShown && !process.env.PRISM_SNAP && !process.argv.includes("--hidden")) {
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
