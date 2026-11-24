// Renders the store promo images with Electron:  npx electron tools/store-art.cjs
//   store/promo-small-440x280.png   (Chrome Web Store "small promo tile", Edge "small promotional tile")
//   store/promo-marquee-1400x560.png (Chrome Web Store marquee, optional)
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const shot = path.join(root, "store", "screenshots", "2-multi-network.png");
const shotUrl = fs.existsSync(shot) ? require("url").pathToFileURL(shot).href : "";

const LOGO = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="5" fill="#4f8cff"/><path d="M12 4.8 19.2 18H4.8z" fill="#fff"/><path d="M12 4.8 19.2 18H12z" fill="#eaf0ff"/><path d="M12 9.6v5.1m0 0-1.9-1.9m1.9 1.9 1.9-1.9" stroke="#3a72ea" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

const page = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0}
  body{width:${w}px;height:${h}px;overflow:hidden;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;color:#eef0f4;
    background:radial-gradient(120% 140% at 0% 0%,#1f2a44 0%,#15171c 55%) }
  .logo svg{display:block}
  h1{font-weight:700;letter-spacing:-.02em}
  p{color:#a9aeb8}
</style></head><body>${body}</body></html>`;

const small = page(
  440,
  280,
  `<div style="padding:34px 32px;height:100%;display:flex;flex-direction:column;justify-content:center;gap:14px">
     <div class="logo" style="width:64px;height:64px">${LOGO}</div>
     <h1 style="font-size:40px">Prism</h1>
     <p style="font-size:17px;line-height:1.35;max-width:360px">Faster downloads over every connection.<br>Any video, in the quality you pick.</p>
   </div>`,
);

const marquee = page(
  1400,
  560,
  `<div style="display:flex;height:100%;align-items:center;padding-left:90px;gap:70px">
     <div style="flex:none;width:420px;display:flex;flex-direction:column;gap:18px">
       <div class="logo" style="width:80px;height:80px">${LOGO}</div>
       <h1 style="font-size:60px">Prism</h1>
       <p style="font-size:22px;line-height:1.4">Every download, faster — over all your connections at once. Videos from 1,000+ sites, in the quality you pick.</p>
     </div>
     ${shotUrl ? `<img src="${shotUrl}" style="width:820px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08);transform:translateY(60px)">` : ""}
   </div>`,
);

async function render(html, w, h, out) {
  const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true, webPreferences: { offscreen: true } });
  const tmp = path.join(app.getPath("temp"), `prism-store-art-${w}x${h}.html`); // too big for a data: URL
  fs.writeFileSync(tmp, html);
  await win.loadFile(tmp);
  fs.rmSync(tmp, { force: true });
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
  fs.writeFileSync(out, img.resize({ width: w, height: h }).toPNG());
  win.destroy();
  console.log("wrote", path.relative(root, out));
}

app.on("window-all-closed", () => {}); // keep running between the two renders
app.whenReady().then(async () => {
  await render(small, 440, 280, path.join(root, "store", "promo-small-440x280.png"));
  await render(marquee, 1400, 560, path.join(root, "store", "promo-marquee-1400x560.png"));
  app.quit();
});
