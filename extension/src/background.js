// Prism browser extension — background. Works as an MV3 service worker (Chrome/Edge/Brave)
// and as an MV2 background page (Firefox).
const api = globalThis.browser ?? globalThis.chrome;
const act = api.action || api.browserAction;
const DEF = { port: 6812, intercept: true, minMB: 0, token: "" };
const cfg = async () => ({ ...DEF, ...(await api.storage.local.get(null)) });
const media = new Map(); // tabId -> sniffed media files
const MAX_MEDIA = 25;

const base = (c) => `http://127.0.0.1:${c.port}`;
const headers = (c) => ({
  "Content-Type": "application/json",
  "X-Prism-Extension": "1",
  ...(c.token ? { "X-Prism-Token": c.token } : {}),
});

function badge(text, title, bad) {
  act.setBadgeBackgroundColor({ color: bad ? "#e5534b" : "#4f8cff" });
  act.setBadgeText({ text });
  if (title) act.setTitle({ title });
  if (text) setTimeout(() => act.setBadgeText({ text: "" }), 2200);
}

async function request(path, body, timeout = 6000) {
  const c = await cfg();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(
      base(c) + path,
      body === undefined
        ? { headers: headers(c), signal: ctrl.signal }
        : { method: "POST", headers: headers(c), body: JSON.stringify(body), signal: ctrl.signal },
    );
    if (r.status === 403) {
      badge("!", "Prism rejected the request — check the token in the extension popup", true);
      return null;
    }
    if (!r.ok) return null;
    return await r.json().catch(() => ({}));
  } catch {
    return null; // Prism isn't running: the browser keeps the download
  } finally {
    clearTimeout(timer);
  }
}

async function post(body) {
  const data = await request("/api/add", body);
  if (data) badge("✓", "Sent to Prism");
  return !!data;
}

async function sendDirect(url, referer, filename) {
  let cookie = "";
  try {
    cookie = (await api.cookies.getAll({ url })).map((k) => `${k.name}=${k.value}`).join("; ");
  } catch {}
  return post({ url, cookie, referer: referer || "", filename: filename || "", ua: navigator.userAgent });
}

// No quality = Prism opens its quality picker.
// Chrome Web Store builds (tools/pack-store.mjs flips this) leave YouTube to the app: store policy
// doesn't allow extensions that download YouTube videos. Pasting the link into Prism still works.
const STORE_BUILD = false;
const storeBlocked = (url) => STORE_BUILD && /^https?:\/\/([^/]+\.)?(youtube\.com|youtu\.be)(\/|$)/i.test(url || "");
const sendMedia = (url, quality) => (storeBlocked(url) ? Promise.resolve(false) : post({ url, media: true, ...(quality ? { quality } : {}) }));

async function sync() {
  const data = await request("/api/ping", undefined, 2000);
  if (!data || data.app !== "prism") return null;
  const patch = { intercept: !!data.settings.intercept, minMB: Number(data.settings.interceptMinMB) || 0 };
  await api.storage.local.set(patch);
  return { ...data, ...patch };
}

// 1) Take over every browser download automatically. Prism's own setting decides (checked live,
//    so changes in Prism apply at once); if Prism isn't running the browser carries on as normal.
api.downloads.onCreated.addListener(async (item) => {
  const url = item.finalUrl || item.url;
  if (!/^https?:/.test(url)) return; // blob:/data: downloads can't be handed over
  const live = await sync();
  if (!live || !live.intercept) return;
  const size = Number(item.fileSize);
  if (live.minMB && size > 0 && size < live.minMB * 1048576) return;
  const name = (item.filename || "").split(/[\\/]/).pop();
  if (await sendDirect(url, item.referrer, name)) {
    try {
      await api.downloads.cancel(item.id);
      await api.downloads.erase({ id: item.id });
    } catch {}
  }
});

// 2) Right-click menus
function menus() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: "prism-direct", title: "Download with Prism", contexts: ["link", "video", "audio", "image"] });
    api.contextMenus.create({ id: "prism-media", title: "Download video with Prism", contexts: ["link", "video", "page"] });
    api.contextMenus.create({ id: "prism-links", title: "Download all links in selection", contexts: ["selection"] });
  });
}
// Check in with Prism as soon as we're installed (its setup page then shows "Connected"), and on browser start.
api.runtime.onInstalled.addListener(() => {
  menus();
  sync();
});
api.runtime.onStartup.addListener(() => {
  menus();
  sync();
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "prism-media") return sendMedia(info.linkUrl || tab.url);
  if (info.menuItemId === "prism-links") {
    try {
      const [{ result }] = await api.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const sel = getSelection();
          const out = new Set();
          for (let i = 0; i < sel.rangeCount; i++) {
            const frag = sel.getRangeAt(i).cloneContents();
            frag.querySelectorAll("a[href]").forEach((a) => out.add(a.href));
          }
          return [...out];
        },
      });
      const urls = (result || []).filter((u) => /^(https?:|magnet:)/.test(u));
      if (urls.length) return post({ urls, referer: tab.url });
    } catch {}
    return;
  }
  const u = info.linkUrl || info.srcUrl || "";
  /^(https?:|magnet:)/.test(u) ? sendDirect(u, tab?.url) : sendMedia(tab.url); // blob: video -> resolve the page
});

// 3) Sniff direct media files so the popup can list them
async function getMedia(tabId) {
  if (media.has(tabId)) return media.get(tabId);
  const key = "m" + tabId;
  const stored = api.storage.session ? (await api.storage.session.get(key))[key] : null;
  return stored || [];
}
api.webRequest.onHeadersReceived.addListener(
  async (d) => {
    if (d.tabId < 0 || d.statusCode >= 300) return;
    const h = (n) => d.responseHeaders.find((x) => x.name.toLowerCase() === n)?.value || "";
    const type = h("content-type");
    const size = +h("content-length") || 0;
    if (!/^(video|audio)\//.test(type) || size < 1048576) return;
    const list = await getMedia(d.tabId);
    if (list.some((m) => m.url === d.url)) return;
    list.unshift({ url: d.url, type, size });
    const trimmed = list.slice(0, MAX_MEDIA);
    media.set(d.tabId, trimmed);
    api.storage.session?.set({ ["m" + d.tabId]: trimmed });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"],
);
api.tabs.onRemoved.addListener((id) => media.delete(id));

api.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.type === "send") {
    (m.media ? sendMedia(m.url, m.quality) : sendDirect(m.url, m.referer || sender.tab?.url)).then(reply);
  } else if (m.type === "media") {
    getMedia(m.tabId).then(reply);
  } else if (m.type === "sync") {
    sync().then(reply);
  } else if (m.type === "show") {
    request("/api/show", {}).then(reply);
  } else return false;
  return true;
});
