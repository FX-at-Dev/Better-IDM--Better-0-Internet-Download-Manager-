# Publishing the Prism extension (one-click install)

Browsers only allow one-click extension installs from their stores. Once the extension is published and its IDs are in `package.json`, Prism behaves like IDM:

- After installing Prism, the browser shows **"Prism was added — Enable extension"** the next time it starts (Prism registers the store extension with Chrome, Edge and Brave for the current user; the uninstaller removes it again).
- The setup page Prism opens becomes a single **Add to Chrome / Add to Edge** button.

Until then, the setup page shows the manual way: one button, switch on Developer mode, drag one folder in.

## 1. Build the packages

```powershell
npm run pack:store
```

This writes:

| File | Upload to |
|---|---|
| `release/store/prism-chrome-edge-1.0.0.zip` | Chrome Web Store **and** Microsoft Edge Add-ons |
| `release/store/prism-firefox-1.0.0.zip` | addons.mozilla.org |

Images are in this folder: `screenshots/` (1280×800), `promo-small-440x280.png`, `promo-marquee-1400x560.png`. The icon is inside the zip (`icons/128.png`).

## 2. Publish

Each store needs its own developer account in your name. You create it and sign in yourself.

### Chrome Web Store
1. Register at the **Chrome Web Store Developer Dashboard** (one-time US$5 fee).
2. **New item** → upload `prism-chrome-edge-1.0.0.zip`.
3. **Store listing**: paste the texts below, category **Productivity**, add the 3 screenshots and the small promo tile.
4. **Privacy**: single purpose and permission justifications below; certify the data use (nothing collected or transferred); privacy policy URL (publish `PRIVACY.md` somewhere public, e.g. a GitHub page).
5. **Submit for review.** Review usually takes a few days; extensions that run on all sites can take longer.

### Microsoft Edge Add-ons
1. Register in **Microsoft Partner Center** for Edge add-ons (free).
2. **Create new extension** → upload the same `prism-chrome-edge-1.0.0.zip`.
3. Same listing texts, screenshots and privacy policy URL. Review takes up to about 7 business days.

### Firefox (addons.mozilla.org)
1. Sign in to the **Add-on Developer Hub** (free).
2. **Submit a New Add-on** → "On this site" → upload `prism-firefox-1.0.0.zip`.
3. Pick the add-on URL slug (e.g. `prism-download-manager`), paste the texts, add screenshots.

## 3. Turn on one-click install in Prism

After approval, copy each store's ID into `package.json`:

```json
"prism": {
  "extensionStores": {
    "chrome": "<32-letter ID from the Chrome Web Store dashboard>",
    "edge": "<32-letter extension ID from Partner Center>",
    "firefox": "<your AMO slug, e.g. prism-download-manager>"
  }
}
```

Then rebuild the installer:

```powershell
npm run dist
```

## Store policy note: YouTube

The Chrome Web Store doesn't accept extensions that download YouTube videos. The store builds therefore hide the **Download video** button on YouTube. Everything else still works there, and the Prism app still downloads YouTube links you paste into it. The Firefox build and the manual (unpacked) install keep the button everywhere.

---

## Listing text

**Name:** Prism Download Manager

**Short description** (132 characters max):
> Send downloads and videos to Prism — faster downloads over every connection, and videos in the quality you pick.

**Description:**
> Prism Download Manager connects your browser to the free Prism app for Windows.
>
> • Every download goes to Prism automatically — split across all your network connections (Wi-Fi, Ethernet, phone tethering) at once, with pause and resume.
> • A Download video button on videos: Prism shows every available quality, with file sizes, and Audio / MP3.
> • Right-click any link → Download with Prism. Select text → Download all links in selection.
> • Files are sorted into Videos, Music, Images, Documents, Compressed, Programs and Others in your Downloads folder.
>
> Requires the Prism app on your computer. The extension only talks to Prism on your own PC (127.0.0.1) and collects no data.

**Single purpose** (Chrome):
> Hand downloads and video pages from the browser to the Prism download manager app on the user's computer.

## Permission justifications

| Permission | Why |
|---|---|
| `downloads` | Hand browser downloads to Prism and cancel the browser's copy. |
| `contextMenus` | "Download with Prism", "Download video with Prism" and "Download all links in selection" in the right-click menu. |
| `cookies` | Send the site's cookies with a handed-over download so files behind a sign-in still download. Sent only to the Prism app on 127.0.0.1. |
| `storage` | Remember the connection settings (local port, optional token). |
| `webRequest` | Notice audio and video files a page loads, so the popup can list them for download. Read-only; no request is blocked or changed. |
| `tabs` | Know the current tab's address for "Download video" and the popup's media list. |
| `scripting` | Read the links inside the user's text selection for "Download all links in selection". |
| Host permission `<all_urls>` | Show the Download video button on whichever site has a video, and detect media files the page loads. |
| Remote code | None. All code is in the package. |
