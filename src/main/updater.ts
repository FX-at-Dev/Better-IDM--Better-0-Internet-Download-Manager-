import https from "node:https";
import { app, Notification, shell } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/types.js";
import { isNewer, versionFromTagUrl } from "./version.js";

export const REPO = "FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-";
/** The download site picks the right file for the visitor's system. */
export const DOWNLOAD_PAGE = "https://fx-at-dev.github.io/Better-IDM--Better-0-Internet-Download-Manager-/";
const EVERY = 4 * 60 * 60 * 1000;

interface Deps {
  autoDownload: () => boolean;
  /** close downloads and save state before the installer takes over */
  shutdown: () => Promise<void>;
  changed: () => void;
  icon: () => Electron.NativeImage;
  showWindow: () => void;
}

/**
 * How this copy of Lanes can update:
 *  - auto: the Windows installer build and the Linux AppImage download the new version and install it
 *    themselves (electron-updater, reading latest.yml from the GitHub release).
 *  - manual: the portable .exe, macOS (installing needs a signed app) and .deb / .tar.gz copies can't
 *    replace themselves, so Lanes only says a new version is out and opens the download page.
 */
function detectMode(): UpdateStatus["mode"] {
  if (process.env.LANES_UPDATE_TEST) return "auto"; // dev: points at a local test server
  if (!app.isPackaged) return "off";
  if (process.platform === "win32") return process.env.PORTABLE_EXECUTABLE_FILE ? "manual" : "auto";
  if (process.platform === "linux") return process.env.APPIMAGE ? "auto" : "manual";
  return "manual";
}

export class Updater {
  status: UpdateStatus;
  private deps!: Deps;
  private notified = "";
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.status = { mode: detectMode(), state: "idle" };
  }

  start(deps: Deps): void {
    this.deps = deps;
    if (this.status.mode === "off") return;
    if (this.status.mode === "auto") this.wireAuto();
    // a little after start: at sign-in the network may not be up yet
    setTimeout(() => void this.check(), 15_000);
    this.timer = setInterval(() => void this.check(), EVERY);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private set(p: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...p };
    this.deps.changed();
  }

  private wireAuto(): void {
    if (process.env.LANES_UPDATE_TEST) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.updateConfigPath = process.env.LANES_UPDATE_TEST;
    }
    autoUpdater.logger = process.env.LANES_UPDATE_TEST ? console : null;
    // a test run (LANES_UPDATE_TEST) never installs what it downloads
    autoUpdater.autoInstallOnAppQuit = !process.env.LANES_UPDATE_TEST;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on("checking-for-update", () => this.set({ state: "checking", error: undefined }));
    autoUpdater.on("update-not-available", () => this.set({ state: "latest", version: undefined, checkedAt: Date.now() }));
    autoUpdater.on("update-available", (info) => {
      this.set({ state: autoUpdater.autoDownload ? "downloading" : "available", version: info.version, percent: 0, checkedAt: Date.now() });
      if (!autoUpdater.autoDownload) this.notify("available", info.version);
    });
    autoUpdater.on("download-progress", (p) => this.set({ state: "downloading", percent: Math.floor(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => {
      this.set({ state: "ready", version: info.version, percent: 100 });
      this.notify("ready", info.version);
    });
    autoUpdater.on("error", (e) => this.fail(e));
  }

  /** Look for a newer version (and, in auto mode with the setting on, start downloading it). */
  async check(): Promise<void> {
    const s = this.status;
    if (s.mode === "off" || s.state === "checking" || s.state === "downloading" || s.state === "ready") return;
    try {
      if (s.mode === "auto") {
        autoUpdater.autoDownload = this.deps.autoDownload();
        await autoUpdater.checkForUpdates();
      } else {
        this.set({ state: "checking", error: undefined });
        const latest = await latestTag();
        if (latest && isNewer(latest, app.getVersion())) {
          this.set({ state: "available", version: latest, checkedAt: Date.now() });
          this.notify("available", latest);
        } else this.set({ state: "latest", version: undefined, checkedAt: Date.now() });
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** The "Download" button: fetch an update found while automatic downloads were off. */
  async download(): Promise<void> {
    if (this.status.mode !== "auto") {
      void shell.openExternal(DOWNLOAD_PAGE);
      return;
    }
    if (this.status.state !== "available") return;
    this.set({ state: "downloading", percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      this.fail(e);
    }
  }

  /** Close Lanes, install the downloaded version, and open the new one. */
  async install(): Promise<void> {
    if (this.status.state !== "ready") return;
    await this.deps.shutdown();
    if (process.env.LANES_UPDATE_TEST) return void app.quit();
    autoUpdater.quitAndInstall(true, true);
  }

  /** Turning the setting on picks up an update that was found while it was off. */
  settingChanged(on: boolean): void {
    if (on && this.status.mode === "auto" && this.status.state === "available") void this.download();
  }

  private fail(e: unknown): void {
    const msg = String((e as Error)?.message ?? e).split("\n")[0];
    const offline = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(msg);
    this.set({
      state: "error",
      error: offline ? "Couldn't reach GitHub — check your connection." : msg.length > 140 ? msg.slice(0, 140) + "…" : msg,
    });
  }

  private notify(kind: "available" | "ready", version: string): void {
    const key = kind + version;
    if (this.notified === key || !Notification.isSupported()) return;
    this.notified = key;
    const n = new Notification({
      title: kind === "ready" ? `Lanes ${version} is ready` : `Lanes ${version} is available`,
      body:
        kind === "ready"
          ? "It installs when you quit Lanes. Click to restart and update now."
          : this.status.mode === "auto"
            ? "Click to download it."
            : "Click to open the download page.",
      icon: this.deps.icon(),
    });
    n.on("click", () => {
      if (kind === "ready") void this.install();
      else if (this.status.mode === "auto") {
        this.deps.showWindow();
        void this.download();
      } else void shell.openExternal(DOWNLOAD_PAGE);
    });
    n.show();
  }
}

/**
 * The latest release's version, from where github.com/<repo>/releases/latest redirects to
 * (.../releases/tag/v1.2.3). Not the REST API, which allows only 60 requests an hour per address.
 */
function latestTag(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://github.com/${REPO}/releases/latest`,
      { method: "HEAD", headers: { "User-Agent": "Lanes" }, timeout: 15_000 },
      (res) => {
        res.resume();
        const loc = res.headers.location;
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) resolve(versionFromTagUrl(loc));
        else reject(new Error(`GitHub answered ${res.statusCode}`));
      },
    );
    req.on("timeout", () => req.destroy(new Error("ETIMEDOUT")));
    req.on("error", reject);
    req.end();
  });
}
