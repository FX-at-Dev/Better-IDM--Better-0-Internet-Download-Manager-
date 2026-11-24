const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const DEF = { port: 6812, intercept: true, minMB: 0, token: "" };

const fmt = (n) => (n > 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : (n / 1048576).toFixed(1) + " MB");

async function load() {
  const c = { ...DEF, ...(await api.storage.local.get(null)) };
  $("port").value = c.port;
  $("token").value = c.token;

  const s = await api.runtime.sendMessage({ type: "sync" });
  if (s) {
    $("status").textContent = `Connected · v${s.version}`;
    $("dot").classList.add("on");
    $("takeover").textContent = s.intercept ? (s.minMB ? `On · files over ${s.minMB} MB` : "On · all files") : "Off";
    $("takeover").classList.toggle("on", !!s.intercept);
  } else {
    $("status").textContent = "Prism isn't running";
    $("takeover").textContent = "Prism not running";
  }

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const list = tab ? await api.runtime.sendMessage({ type: "media", tabId: tab.id }) : [];
  if (list && list.length) {
    const box = $("media");
    box.textContent = "";
    for (const m of list) {
      const row = document.createElement("div");
      row.className = "m";
      const name = document.createElement("span");
      name.textContent = `${decodeURIComponent(new URL(m.url).pathname.split("/").pop() || m.type)} · ${fmt(m.size)}`;
      name.title = m.url;
      const b = document.createElement("button");
      b.textContent = "Get";
      b.onclick = async () => {
        b.textContent = (await api.runtime.sendMessage({ type: "send", url: m.url, referer: tab.url })) ? "✓" : "!";
      };
      row.append(name, b);
      box.append(row);
    }
  }

  $("page").onclick = async () => {
    $("page").textContent = "Sending…";
    const ok = await api.runtime.sendMessage({ type: "send", url: tab.url, media: true });
    $("page").textContent = ok ? "Opened in Prism" : "Start Prism first";
  };
  $("open").onclick = () => api.runtime.sendMessage({ type: "show" });
}

for (const id of ["port", "token"]) {
  $(id).addEventListener("change", () => {
    const v = id === "token" ? $(id).value.trim() : Number($(id).value) || 0;
    api.storage.local.set({ [id]: v });
  });
}

load();
