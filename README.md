# Lanes

A download manager that pulls every file over **all of your network connections at once**, wrapped in a Liquid Glass interface.

A from-scratch rebuild of the ideas in [Qorvex](https://github.com/PagalSarthak/qorvex) (MIT), in Electron + TypeScript + React.

Website: https://fx-at-dev.github.io/Better-IDM--Better-0-Internet-Download-Manager-/ (source in [`site/`](site/), published by `.github/workflows/pages.yml`).

## Download

**[⬇ Download Lanes](https://fx-at-dev.github.io/Better-IDM--Better-0-Internet-Download-Manager-/)** — the website picks the right file for your system. Or grab any file from the [latest release](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/latest):

Current version: **1.1.4**

| System | File |
|---|---|
| Windows | [Installer](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/Lanes-Setup-1.1.4.exe) · [Portable](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/Lanes-1.1.4-portable.exe) |
| macOS | [Apple Silicon (M1–M4)](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/Lanes-1.1.4-mac-arm64.dmg) · [Intel](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/Lanes-1.1.4-mac-x64.dmg) |
| Linux | [AppImage](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/Lanes-1.1.4-linux-x86_64.AppImage) · [.deb](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/lanes_1.1.4_amd64.deb) · [.tar.gz](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/Lanes-1.1.4-linux-x64.tar.gz) |
| Browser stores | [Chrome / Edge package](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/lanes-chrome-edge-1.1.4.zip) · [Firefox package](https://github.com/FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-/releases/download/v1.1.4/lanes-firefox-1.1.4.zip) |

**Updates:** from 1.1.4 on, the Windows installer and the Linux AppImage download new versions by themselves and install them when Lanes restarts (Settings → Updates). The portable, macOS and package builds tell you when a new version is out. If you have 1.1.3 or older, install 1.1.4 once by hand.

The builds aren't code-signed yet, so the first launch needs one extra click: Windows **More info → Run anyway**; macOS right-click → **Open**.

> Lanes was called **Prism** in version 1.0.0. Installing Lanes replaces it and keeps your settings, download list and unfinished downloads.

## What's in it

**Downloading**
- Everything goes to your Windows **Downloads** folder, sorted by type: `Videos`, `Music`, `Images`, `Documents`, `Compressed`, `Programs`, `Torrents`, and `Others` for anything unrecognised. You can change the folder, turn sorting off, or pick a different folder for one download.
- **Multi-network bonding**: each file is split into segments and every enabled network (Wi-Fi, Ethernet, USB tether…) runs its own parallel connections. Idle connections split the biggest remaining segment (work stealing), so faster networks carry more and nothing idles at the end.
- Every ranged response is checked (`206` + matching `Content-Range`) before anything is written. Servers without range support fall back to one connection, and unknown-length (chunked) downloads work too.
- Pause/resume survives restarts. A resume is refused if the file changed on the server (size, ETag or Last-Modified).
- A network that keeps failing drops out of that download. If every network is off, the download pauses instead of failing.
- Global and per-network speed caps, plus per-network connection counts.
- **Video from any site yt-dlp supports** (YouTube, X, Instagram, TikTok, Dailymotion, Reddit and 1,000+ more). Paste the page link and Lanes **asks for the quality first**: every resolution the site offers, with its size, plus Audio and MP3. Playlists offer “up to 1080p”-style choices for all videos at once.
  - Plain-HTTP formats (most of YouTube) are resolved once per network, because those links are IP-locked, and download over every network at once.
  - Stream-only sites (HLS/DASH) are downloaded by yt-dlp itself over one network.
  - Separate video and audio are joined with ffmpeg; MP3 is converted with ffmpeg. yt-dlp is installed with one click the first time; ffmpeg installs itself the first time it's needed.
  - YouTube's JavaScript challenges are solved with deno/node if installed, otherwise with Lanes's own executable running as Node.
- **Torrents** via WebTorrent: magnet links, `.torrent` URLs, `.torrent` files (picker or drag & drop), seed-to-ratio. Unlike Qorvex, torrents persist across restarts.

**New in Lanes**
- **Live graphs**: a per-download speed graph, a per-network speed history, and a combined-speed sparkline in the title bar.
- **Chunk map**: an IDM-style grid in the details panel showing which network is filling which part of the file, live. The progress bar in each row is coloured per network too.
- **Scheduler & queues**: any number of queues, each with a time window (overnight windows like 23:00–06:00 work), weekdays, a max-at-once limit, and an action when it finishes (quit / sleep / shut down, always after a 60-second countdown you can cancel).
- **Checksums**: paste an expected hash (the algorithm is detected from its length) and the download is verified when it finishes. You can also verify any finished file, or hash every download automatically.
- **Smart naming**: names come from `Content-Disposition` (including RFC 5987 UTF-8 names), then the URL, with an extension guessed from the MIME type. Windows reserved names are handled, and collisions become `name (1).ext`.
- **Duplicate detection**: ask, download again, or skip.
- **Site rules**: send `*.github.com` (for example) to its own folder, category, queue or connection count.
- **Themes**: Liquid Glass (Windows acrylic backdrop with tinted panes; dialogs and menus get a specular rim and optional refraction), Dark, Light and System. Pick an accent colour, glass opacity, and a compact list.
- A table-style download list (name, size, status, speed, time left, added) with sortable columns, a sidebar with status views, categories and queues, search, multi-select (Ctrl/Shift-click), a right-click menu and keyboard shortcuts.

**Desktop**
- A tray icon with pause/resume all, close-to-tray, completion notifications and start with Windows.
- A **clipboard catcher**: copy a link to a file or a magnet link and Lanes offers to download it.
- Drag links or `.torrent` files anywhere onto the window.

**Browser extension** (`extension/`, Chrome/Edge/Brave MV3 + Firefox MV2) — the IDM-style integration
- On first launch after installing, Lanes opens a setup page in the default browser (`http://127.0.0.1:6812/welcome`). One **Start** button opens the browser's extensions page and the extension folder side by side; the user switches on Developer mode and drags the folder in, and the page switches to “You're all set” as soon as the extension checks in. It can be reopened from Settings → Browser extension.
- **One-click install, IDM-style, once the extension is published**: put the store IDs in `package.json` → `lanes.extensionStores` and Lanes registers the extension with Chrome/Edge/Brave (they then show "Extension added — Enable?"), and the setup page becomes a single "Add to <browser>" button. `npm run pack:store` builds the store packages; see [store/README.md](store/README.md) for the publishing steps, listing text, screenshots and privacy policy.
- Takes over every browser download automatically and starts it straight away (Settings → Browser extension has the on/off switch, a size threshold, and an optional “Ask before downloading”). If Lanes isn't running, the browser keeps the download.
- Shows a **Download video** button over videos; it opens Lanes's quality picker for that page.
- Right-click menu items: Download with Lanes, Download video, and Download all links in selection.
- The popup lists media files detected on the page.

## Run

```powershell
npm install
npm start            # build + launch
npm run dev          # hot-reload UI (Vite) + watch main process
npm test             # engine tests against a real local ranged HTTP server
npm run dist:win     # Windows installer + portable exe in release/
npm run dist:mac     # macOS .dmg/.zip (must run on a Mac)
npm run dist:linux   # AppImage, .deb, .tar.gz (must run on Linux)
npm run pack:store   # browser-store packages in release/store/
```

npm 11 blocks install scripts by default. `package.json` already allows the ones Lanes needs (`electron`, `node-datachannel`, `electron-winstaller`).

## Releases

`.github/workflows/release.yml` builds Windows, macOS and Linux on GitHub's machines for every push. To publish a version, bump `version` in package.json, then:

```powershell
git tag v1.0.0
git push origin v1.0.0
```

The workflow attaches every installer (and the browser-store packages) to a GitHub Release for that tag, along with the `latest*.yml` and `.blockmap` files that installed copies of Lanes check for updates.

## Security model of the local API (`127.0.0.1:6812`)

The API is only for the browser extension.

- It listens on loopback only.
- It rejects any `Host` other than `127.0.0.1`/`localhost`, which blocks DNS rebinding.
- It rejects web-page `Origin`s and allows only `chrome-extension://`/`moz-extension://`.
- POST requests must be `application/json`.
- Bodies are capped at 1 MB.
- An optional token is compared in constant time.

## Honest limits

- A real speed-up needs genuinely separate uplinks. Wi-Fi and Ethernet on the same router share one internet line.
- IPv4 only. Stream-only (HLS/DASH) videos download over one network, not all of them.
- Some sites need you to be signed in (Vimeo, private or age-restricted videos). Turn on “Use cookies from browser” in Settings.
- Torrent traffic is not bonded per network.
- The installer is unsigned, so Windows SmartScreen will warn on first run.

## Layout

```
src/main/       engine (segmented.ts, http.ts, manager.ts), networks, media (yt-dlp), torrent, API, tray/IPC (main.ts)
src/renderer/   React UI — App, components/, styles.css (themes + glass)
src/shared/     types shared by both sides
extension/src/  browser extension source → tools/build-extension.mjs → extension/build/
tests/          node:test suites
tools/          icon generator, extension builder
```
