// Lanes download site: detect the visitor's system and fill in the newest release's files from GitHub.
(() => {
  const REPO = "FX-at-Dev/Better-IDM--Better-0-Internet-Download-Manager-";
  const RELEASES = `https://github.com/${REPO}/releases/latest`;

  // Which file each button should get. Matching on patterns keeps working for every future version.
  const PATTERNS = {
    setup: /^(Lanes|Prism)-Setup-.*\.exe$/,
    portable: /-portable\.exe$/,
    "mac-arm64": /-mac-arm64\.dmg$/,
    "mac-x64": /-mac-x64\.dmg$/,
    appimage: /\.AppImage$/,
    deb: /_amd64\.deb$/,
    targz: /-linux-x64\.tar\.gz$/,
  };

  function detectOS() {
    const p = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
    const ua = navigator.userAgent.toLowerCase();
    if (/android|iphone|ipad|ipod/.test(ua)) return "mobile";
    if (p.includes("win") || ua.includes("windows")) return "windows";
    if (p.includes("mac") || ua.includes("mac os")) return "mac";
    if (p.includes("linux") || ua.includes("linux") || ua.includes("x11")) return "linux";
    return "unknown";
  }

  const mb = (n) => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.round(n / 1024)} KB`);
  const os = detectOS();
  const heroBtn = document.getElementById("hero-download");
  const heroLabel = document.getElementById("hero-label");
  const heroMeta = document.getElementById("hero-meta");

  // highlight the visitor's system
  const card = document.querySelector(`.dl-card[data-os="${os}"]`);
  if (card) card.classList.add("yours");

  // until the API answers (or if it can't), every button goes to the releases page
  document.querySelectorAll("[data-asset]").forEach((a) => (a.href = RELEASES));
  const heroAsset = { windows: "setup", mac: "mac-arm64", linux: "appimage" }[os];
  const heroName = { windows: "Windows", mac: "macOS", linux: "Linux" }[os];
  if (heroAsset) {
    heroLabel.textContent = `Download for ${heroName}`;
    heroBtn.href = RELEASES;
  } else if (os === "mobile") {
    heroLabel.textContent = "Get Lanes for your computer";
    heroMeta.textContent = "Lanes runs on Windows, macOS and Linux.";
  }

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      const version = String(rel.tag_name || "").replace(/^v/, "");
      const byKey = {};
      for (const [key, re] of Object.entries(PATTERNS)) {
        const asset = (rel.assets || []).find((x) => re.test(x.name));
        if (asset) byKey[key] = asset;
      }
      document.querySelectorAll("[data-asset]").forEach((a) => {
        const asset = byKey[a.dataset.asset];
        if (!asset) return;
        a.href = asset.browser_download_url;
        a.querySelector(".size").textContent = mb(asset.size);
        a.title = asset.name;
      });
      if (version) document.getElementById("version-label").textContent = version;
      if (rel.html_url) document.getElementById("release-notes").href = rel.html_url;

      const hero = byKey[heroAsset];
      if (hero) {
        heroBtn.href = hero.browser_download_url;
        const what = { windows: "Windows 10/11 installer", mac: "Apple Silicon · Intel below", linux: "AppImage" }[os];
        heroMeta.innerHTML = `v${version} · ${what} · ${mb(hero.size)} · <a href="#download">Other systems</a>`;
      }
    })
    .catch(() => {
      /* offline or rate-limited: the buttons already point to the releases page */
    });
})();
