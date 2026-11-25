// The setup page Lanes opens in the user's browser on first launch. It is served by the local
// API (http://127.0.0.1:<port>/welcome), detects which browser it is in, and flips to
// "You're all set" by itself once the extension pings Lanes.
//  - Once the extension is in the browser's store: one "Add to <browser>" button.
//  - Until then: one button that opens the extensions page and the extension folder side by side,
//    then the user switches on Developer mode and drags the folder in.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface StoreLinks {
  chrome?: string;
  edge?: string;
  firefox?: string;
}

export function welcomePage(o: { version: string; chromePath: string; firefoxPath: string; stores: StoreLinks }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Add Lanes to your browser</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(LOGO)}" />
<style>
  :root { --accent:#4f8cff; --ok:#3fb67a; --bg:#17181b; --layer:#1d1e22; --card:#232429; --border:rgba(255,255,255,.08);
    --text:#e9eaee; --text-2:#a4a8b0; --text-3:#6d727b; color-scheme:dark }
  @media (prefers-color-scheme: light) { :root { --bg:#f1f2f4; --layer:#fbfbfc; --card:#fff; --border:rgba(0,0,0,.09);
    --text:#1b1d21; --text-2:#5c616a; --text-3:#8d929b; color-scheme:light } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; -webkit-font-smoothing:antialiased }
  main { max-width:680px; margin:0 auto; padding:48px 24px 64px }
  header { display:flex; align-items:center; gap:12px; margin-bottom:28px }
  header svg { width:36px; height:36px }
  header b { font-size:15px } header span { color:var(--text-3); font-size:12.5px; display:block }
  h1 { font:600 28px/1.2 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif; margin:0 0 8px; letter-spacing:-.01em }
  .lead { color:var(--text-2); margin:0 0 24px; max-width:600px }
  .card { padding:20px; border-radius:12px; background:var(--layer); border:1px solid var(--border) }
  .big-btn { height:44px; padding:0 22px; font-size:15px }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center }
  button, a.btn { height:34px; padding:0 14px; border-radius:6px; border:1px solid var(--border); background:var(--card); color:var(--text); font:600 13px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:8px }
  button:hover, a.btn:hover { filter:brightness(1.12) }
  .primary { background:var(--accent) !important; border-color:transparent !important; color:#fff !important }
  .big-btn { height:44px !important; padding:0 22px !important; font-size:15px !important }
  ol.steps { list-style:none; margin:18px 0 0; padding:0; display:flex; flex-direction:column; gap:14px; counter-reset:s }
  ol.steps > li { counter-increment:s; display:grid; grid-template-columns:28px 1fr; gap:12px; align-items:start }
  ol.steps > li::before { content:counter(s); width:26px; height:26px; border-radius:50%; display:grid; place-items:center; font-weight:600; font-size:12.5px; background:color-mix(in srgb,var(--accent) 16%,transparent); color:var(--accent) }
  li b { font-weight:600 }
  li p { margin:2px 0 0; color:var(--text-2); font-size:13px }
  .mock { display:inline-flex; align-items:center; gap:8px; padding:2px 9px; border-radius:6px; background:var(--card); border:1px solid var(--border); font-size:12.5px; vertical-align:middle }
  .mock .sw { width:26px; height:15px; border-radius:8px; background:var(--accent); position:relative } .mock .sw::after { content:""; position:absolute; right:3px; top:3px; width:9px; height:9px; border-radius:50%; background:#fff }
  .status { display:flex; align-items:center; gap:10px; margin-top:18px; color:var(--text-2); font-size:13px }
  .status .dot { width:9px; height:9px; border-radius:50%; background:var(--text-3); flex:none; animation:pulse 1.6s ease-in-out infinite }
  @keyframes pulse { 50% { opacity:.35 } }
  details { margin-top:18px; color:var(--text-2); font-size:13px }
  summary { cursor:pointer; color:var(--text-2) }
  .path { display:flex; align-items:center; gap:8px; margin-top:8px; padding:6px 6px 6px 10px; border-radius:6px; background:var(--card); border:1px solid var(--border); font:12px "Cascadia Mono",Consolas,monospace; word-break:break-all }
  .path span { flex:1 } .path button { height:26px; flex:none }
  .note { color:var(--text-3); font-size:12.5px; margin-top:18px }
  .hidden { display:none !important }
  .done { text-align:center; padding:40px 16px }
  .done .tick { width:64px; height:64px; margin:0 auto 16px; border-radius:50%; display:grid; place-items:center; background:color-mix(in srgb,var(--ok) 16%,transparent); color:var(--ok); font-size:32px }
  .toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); padding:8px 14px; border-radius:8px; background:var(--card); border:1px solid var(--border); font-size:13px; opacity:0; transition:opacity .2s }
  .toast.show { opacity:1 }
</style>
</head>
<body>
<main>
  <header>${LOGO}<div><b>Lanes</b><span>Version ${esc(o.version)}</span></div></header>

  <section id="setup">
    <h1>Add Lanes to <span class="bname">your browser</span></h1>
    <p class="lead">Then every download from <span class="bname">your browser</span> goes to Lanes automatically, and videos get a <b>Download video</b> button.</p>

    <!-- published: one click -->
    <div class="card hidden" id="store">
      <a class="btn primary big-btn" id="store-link" target="_blank" rel="noopener">Add to <span class="bname">browser</span></a>
      <p class="note" style="margin-top:12px">Opens the official extension page — click <b>Add</b> there.</p>
    </div>

    <!-- not published yet: one button, one switch, one drag -->
    <div class="card hidden" id="manual">
      <button class="primary big-btn" data-act="both">Start</button>
      <ol class="steps">
        <li><div><b>Switch on Developer mode</b> on the page that opens <span class="mock">Developer mode <i class="sw"></i></span><p id="dev-where">It's in the left sidebar.</p></div></li>
        <li><div><b>Drag the highlighted “Lanes Extension” folder</b> from the folder window onto that page.<p>That's it — this page will say so.</p></div></li>
      </ol>
      <details>
        <summary>Drag and drop not working?</summary>
        <p>Click <b>Load unpacked</b> on the extensions page, paste this path into the address bar of the folder window, and click <b>Select Folder</b>.</p>
        <div class="path"><span id="chrome-path">${esc(o.chromePath)}</span><button data-copy="#chrome-path">Copy</button></div>
      </details>
    </div>

    <div class="card hidden" id="firefox">
      <button class="primary big-btn" data-act="both">Start</button>
      <ol class="steps">
        <li><div><b>Click “Load Temporary Add-on…”</b> on the page that opens</div></li>
        <li><div><b>Pick the highlighted manifest.json</b><p class="path"><span id="ff-path">${esc(o.firefoxPath)}</span><button data-copy="#ff-path">Copy</button></p></div></li>
      </ol>
      <p class="note">Firefox removes add-ons loaded this way when it restarts, until Lanes's add-on is published on addons.mozilla.org. For now, Edge or Chrome is the better choice.</p>
    </div>

    <div class="status" id="status"><span class="dot"></span><span id="status-text">Waiting for the extension…</span></div>
  </section>

  <section id="done" class="hidden done">
    <div class="tick">✓</div>
    <h1>You're all set</h1>
    <p class="lead" style="margin:8px auto 0">Lanes is connected to <span class="bname">your browser</span>. Downloads now go straight to Lanes, sorted into your Downloads folder. You can close this tab.</p>
  </section>
</main>
<div class="toast" id="toast"></div>
<script>
  const STORES = ${JSON.stringify(o.stores).replace(/</g, "\\u003c")};
  const ua = navigator.userAgent;
  const browser = navigator.brave ? "Brave" : /Edg\\//.test(ua) ? "Edge" : /OPR\\//.test(ua) ? "Opera" : /Firefox\\//.test(ua) ? "Firefox" : /Chrome\\//.test(ua) ? "Chrome" : "";
  const key = { Edge: "edge", Chrome: "chrome", Brave: "brave", Opera: "opera", Firefox: "firefox" }[browser] || "chrome";
  document.querySelectorAll(".bname").forEach((e) => (e.textContent = browser || "your browser"));
  const store = STORES[key === "brave" ? "chrome" : key];
  const show = (id) => document.getElementById(id).classList.remove("hidden");
  if (store) {
    show("store");
    document.getElementById("store-link").href = store;
  } else show(key === "firefox" ? "firefox" : "manual");
  document.getElementById("dev-where").textContent = key === "edge" ? "It's in the left sidebar." : "It's in the top-right corner.";

  const toast = (t) => {
    const el = document.getElementById("toast");
    el.textContent = t;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2000);
  };
  document.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", async () => {
      const text = document.querySelector(b.dataset.copy).textContent.trim();
      try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Select the text and press Ctrl+C"); }
    }),
  );
  document.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        const r = await fetch("/welcome/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: b.dataset.act, browser: key }) });
        toast(r.ok ? "Opening the extensions page and the folder…" : "Lanes couldn't open them — use the steps below");
      } catch { toast("Lanes isn't running"); }
    }),
  );

  let connected = false;
  async function poll() {
    try {
      const s = await (await fetch("/welcome/status", { cache: "no-store" })).json();
      const mine = s.connected.includes(browser === "Brave" ? "Chrome" : browser); // Brave reports itself as Chrome
      if (mine && !connected) {
        connected = true;
        document.getElementById("setup").classList.add("hidden");
        show("done");
        document.title = "Lanes is connected";
      } else if (!mine) {
        document.getElementById("status-text").textContent = s.connected.length
          ? "Already connected in " + s.connected.join(", ") + ". Waiting for " + (browser || "this browser") + "…"
          : "Waiting for the extension… this page updates by itself.";
      }
    } catch {
      document.getElementById("status-text").textContent = "Lanes isn't running. Start Lanes, then reload this page.";
    }
    if (!connected) setTimeout(poll, 1500);
  }
  poll();
</script>
</body>
</html>`;
}

const LOGO = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="5" fill="#4f8cff"/><path d="M7.2 4.8 12 15.4M12 4.8v10.6M16.8 4.8 12 15.4M7.4 19.2h9.2" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

/** "Edge", "Chrome", "Firefox", "Opera" from a request's User-Agent (Brave reports itself as Chrome). */
export function browserFromUA(ua: string): string {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  return "Browser";
}
