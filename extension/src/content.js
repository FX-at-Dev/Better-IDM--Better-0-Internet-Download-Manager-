// A "Download" button over videos (YouTube, Vimeo, news sites, direct mp4…), like IDM's.
// Clicking it opens Prism's quality picker for the page.
(() => {
  if (window.__prism) return;
  window.__prism = true;
  const STORE_BUILD = false; // see background.js — no button on YouTube in store builds
  if (STORE_BUILD && /(^|\.)youtube\.com$/i.test(location.hostname)) return;
  const api = globalThis.browser ?? globalThis.chrome;
  let host, btn, label, mode, hideT;

  function build() {
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;display:none;top:0;left:0";
    const sh = host.attachShadow({ mode: "closed" });
    sh.innerHTML = `<style>
      :host{all:initial}
      button{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:7px;height:32px;padding:0 13px 0 10px;
        font:600 12.5px/1 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:#f2f3f5;cursor:pointer;
        border-radius:8px;background:rgba(24,25,30,.78);
        backdrop-filter:blur(16px) saturate(160%);-webkit-backdrop-filter:blur(16px) saturate(160%);
        box-shadow:0 4px 16px rgba(0,0,0,.35),inset 0 0 0 1px rgba(255,255,255,.14),inset 0 1px 0 rgba(255,255,255,.18);
        transition:background .12s}
      button:hover{background:rgba(36,38,46,.9)}
      button:active{transform:translateY(.5px)}
      svg{width:16px;height:16px;flex:none;color:#4f8cff}</style>
      <button title="Download with Prism"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0l-5-5m5 5l5-5M4 19h16"/></svg><span>Download video</span></button>`;
    btn = sh.querySelector("button");
    label = sh.querySelector("span");
    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (mode.direct) send({ url: mode.direct, referer: location.href }, "Sent to Prism");
      else send({ url: mode.page, media: true }, "Opening Prism…");
    };
  }
  function flash(t) {
    label.textContent = t;
    setTimeout(() => (label.textContent = "Download video"), 2000);
  }
  async function send(msg, ok) {
    flash("Sending…");
    try {
      flash((await api.runtime.sendMessage({ type: "send", ...msg })) ? ok : "Start Prism first");
    } catch {
      flash("Reload the page");
    }
  }
  // Direct file URL -> download as-is. blob:/MSE/HLS (YouTube…) -> Prism reads the page with yt-dlp.
  const modeOf = (v) => {
    const s = v.currentSrc || v.src || "";
    return /^https?:/.test(s) && !/\.(m3u8|mpd)(\?|$)/i.test(s) ? { direct: s } : { page: location.href };
  };
  function place(v) {
    if (!host) build();
    const r = v.getBoundingClientRect();
    host.style.top = Math.max(8, r.top + 12) + "px";
    host.style.left = Math.max(8, r.right - 172) + "px";
    mode = modeOf(v);
    const root = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== root) root.appendChild(host);
    host.style.display = "block";
  }
  const hide = () => host && (host.style.display = "none");
  let last = 0;
  document.addEventListener(
    "mousemove",
    (e) => {
      const t = performance.now();
      if (t - last < 120) return;
      last = t;
      const els = document.elementsFromPoint(e.clientX, e.clientY);
      if (host && els.includes(host)) {
        clearTimeout(hideT);
        return;
      }
      const v = els.find((x) => x.tagName === "VIDEO" && x.clientWidth > 240 && x.clientHeight > 135);
      clearTimeout(hideT);
      if (v) {
        place(v);
        hideT = setTimeout(hide, 2800);
      } else hideT = setTimeout(hide, 500);
    },
    true,
  );
})();
