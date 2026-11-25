import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startApi } from "../src/main/api.js";
import { defaultSettings } from "../src/main/store.js";

const PORT = 46813;
const SELF = `http://127.0.0.1:${PORT}`;
const settings = { ...defaultSettings(), extensionBrowsers: [] as string[] };
const calls: { seen: string[]; open: string[]; ask: number; add: number } = { seen: [], open: [], ask: 0, add: 0 };
let server: http.Server;

before(async () => {
  server = await startApi(
    {
      version: "9.9.9",
      settings: () => settings,
      add: () => (calls.add++, { added: ["x"], duplicates: [], errors: [] }),
      ask: () => void calls.ask++,
      show: () => {},
      extensionSeen: (b) => {
        calls.seen.push(b);
        settings.extensionBrowsers = [...new Set([...settings.extensionBrowsers, b])];
      },
      extensionPaths: () => ({ chrome: "C:\\Users\\a\\Lanes\\extension\\chrome", firefox: "C:\\x\\firefox\\manifest.json" }),
      storeLinks: () => ({}),
      openForSetup: (a, b) => void calls.open.push(`${a}:${b}`),
    },
    PORT,
  );
});
after(() => server.close());

function req(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, text, headers: res.headers }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

test("setup page is served with the extension folder and a locked-down CSP", async () => {
  const r = await req("GET", "/welcome");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"] ?? "", /text\/html/);
  assert.match(r.text, /Add Lanes to/);
  assert.ok(r.text.includes("C:\\Users\\a\\Lanes\\extension\\chrome"));
  assert.match(String(r.headers["content-security-policy"]), /connect-src 'self'/);
});

test("setup page status reports connected browsers", async () => {
  const r = await req("GET", "/welcome/status");
  assert.deepEqual(JSON.parse(r.text), { connected: [] });
});

test("only the setup page itself may trigger its actions", async () => {
  const body = JSON.stringify({ action: "folder", browser: "edge" });
  const json = { "Content-Type": "application/json" };
  assert.equal((await req("POST", "/welcome/open", { ...json, Origin: "https://evil.example" }, body)).status, 403);
  assert.equal((await req("POST", "/welcome/open", json, body)).status, 403, "no Origin = not from the page");
  assert.equal((await req("GET", "/welcome", { Origin: "https://evil.example" })).status, 403);
  assert.equal(calls.open.length, 0);
  const ok = await req("POST", "/welcome/open", { ...json, Origin: SELF }, body);
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.open, ["folder:edge"]);
  const bad = await req("POST", "/welcome/open", { ...json, Origin: SELF }, JSON.stringify({ action: "rm -rf", browser: "edge" }));
  assert.equal(bad.status, 400);
});

test("DNS rebinding: a foreign Host header is refused everywhere", async () => {
  assert.equal((await req("GET", "/welcome", { Host: "attacker.example" })).status, 403);
});

test("the extension checking in marks its browser as connected", async () => {
  const edgeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0";
  const r = await req("GET", "/api/ping", { Origin: "chrome-extension://abc", "X-Lanes-Extension": "1", "User-Agent": edgeUA });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.seen, ["Edge"]);
  const s = await req("GET", "/welcome/status");
  assert.deepEqual(JSON.parse(s.text), { connected: ["Edge"] });
});

test("web pages still can't add downloads; caught files start without a dialog", async () => {
  const json = { "Content-Type": "application/json" };
  const body = JSON.stringify({ url: "https://example.com/a.zip" });
  assert.equal((await req("POST", "/api/add", { ...json, Origin: "https://evil.example" }, body)).status, 403);
  assert.equal((await req("POST", "/api/add", { ...json, Origin: SELF }, body)).status, 403, "the setup page can't add downloads either");
  const r = await req("POST", "/api/add", { ...json, Origin: "chrome-extension://abc" }, body);
  assert.equal(r.status, 200);
  assert.equal(calls.add, 1);
  assert.equal(calls.ask, 0);
  const v = await req("POST", "/api/add", { ...json, Origin: "chrome-extension://abc" }, JSON.stringify({ url: "https://youtube.com/watch?v=x", media: true }));
  assert.equal(JSON.parse(v.text).asked, true, "videos open the quality picker");
});
