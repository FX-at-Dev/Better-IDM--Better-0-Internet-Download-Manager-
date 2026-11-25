import http from "node:http";
import crypto from "node:crypto";
import type { AddOptions, AddRequest, AddResult, Settings } from "../shared/types.js";
import { browserFromUA, welcomePage, type StoreLinks } from "./welcome.js";

const MAX_BODY = 1024 * 1024;

export interface ApiDeps {
  version: string;
  settings: () => Settings;
  add: (o: AddOptions) => AddResult;
  /** open the New download dialog with these links (file info / quality picker) */
  ask: (r: AddRequest) => void;
  show: () => void;
  /** the extension checked in from this browser */
  extensionSeen: (browser: string) => void;
  /** for the setup page */
  extensionPaths: () => { chrome: string; firefox: string };
  storeLinks: () => StoreLinks;
  openForSetup: (action: "folder", browser: string) => void;
}

/**
 * Loopback-only HTTP API used by the browser extension.
 *  - rejects any Host other than 127.0.0.1/localhost (blocks DNS rebinding)
 *  - rejects web-page Origins; only browser-extension origins may call it
 *  - POST bodies must be application/json, so plain HTML forms cannot drive it
 *  - optional shared token
 */
export function startApi(deps: ApiDeps, port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      const data = JSON.stringify(body);
      res.writeHead(code, {
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        ...cors(req),
      });
      res.end(data);
    };

    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: "bad host" });
    const origin = String(req.headers.origin ?? "");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    // The setup page opened in the browser on first launch. It may only talk to its own origin.
    if (url.pathname === "/welcome" || url.pathname.startsWith("/welcome/")) {
      const self = `http://127.0.0.1:${port}`;
      if (origin && origin !== self) return send(403, { error: "origin not allowed" });
      if (req.method === "GET" && url.pathname === "/welcome") {
        const p = deps.extensionPaths();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'",
        });
        return res.end(welcomePage({ version: deps.version, chromePath: p.chrome, firefoxPath: p.firefox, stores: deps.storeLinks() }));
      }
      if (req.method === "GET" && url.pathname === "/welcome/status") return send(200, { connected: deps.settings().extensionBrowsers });
      if (req.method === "POST" && url.pathname === "/welcome/open") {
        // a POST must come from the page itself (browsers always send Origin on POST)
        if (origin !== self) return send(403, { error: "origin not allowed" });
        let raw = "";
        req.on("data", (c: Buffer) => {
          raw += c;
          if (raw.length > 1000) req.destroy();
        });
        req.on("end", () => {
          let b: any = {};
          try {
            b = JSON.parse(raw || "{}");
          } catch {}
          const action = b.action === "folder" ? "folder" : null;
          const browser = ["edge", "chrome", "brave", "opera", "firefox"].includes(b.browser) ? b.browser : "chrome";
          if (!action) return send(400, { error: "bad action" });
          deps.openForSetup(action, browser);
          send(200, { ok: true });
        });
        return;
      }
      return send(404, { error: "not found" });
    }

    if (origin && !/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) return send(403, { error: "origin not allowed" });

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      return res.end();
    }

    const s = deps.settings();
    if (s.apiToken) {
      const got = String(req.headers["x-lanes-token"] ?? req.headers["x-prism-token"] ?? ""); // x-prism-*: extension from 1.0.0
      const a = Buffer.from(got);
      const b = Buffer.from(s.apiToken);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(403, { error: "bad token" });
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      if (req.headers["x-lanes-extension"] === "1" || req.headers["x-prism-extension"] === "1") deps.extensionSeen(browserFromUA(String(req.headers["user-agent"] ?? "")));
      return send(200, {
        app: "lanes",
        version: deps.version,
        settings: { intercept: s.intercept, interceptMinMB: s.interceptMinMB, defaultQuality: s.defaultQuality },
      });
    }
    if (req.method !== "POST") return send(404, { error: "not found" });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: "json only" });

    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(413, { error: "too large" });
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(400, { error: "bad json" });
      }
      if (url.pathname === "/api/add") {
        const urls: string[] = Array.isArray(body.urls) ? body.urls : [body.url];
        const clean = urls.filter((u) => typeof u === "string" && /^(https?:|magnet:)/i.test(u)).slice(0, 200);
        if (!clean.length) return send(400, { error: "no valid url" });
        const common = {
          urls: clean,
          media: !!body.media,
          filename: typeof body.filename === "string" ? body.filename.split(/[\\/]/).pop() : undefined,
          cookie: typeof body.cookie === "string" ? body.cookie : undefined,
          referer: typeof body.referer === "string" ? body.referer : undefined,
          ua: typeof body.ua === "string" ? body.ua : undefined,
          source: "extension" as const,
        };
        // Videos always ask for a quality (unless the extension named one). Caught files start right away,
        // unless "Ask before downloading" is on.
        const quality = typeof body.quality === "string" ? body.quality : undefined;
        if ((common.media && !quality) || (!common.media && s.askBrowserDownloads) || body.ask === true) {
          deps.ask(common);
          return send(200, { ok: true, asked: true, added: [], duplicates: [], errors: [] });
        }
        const r = deps.add({ ...common, quality });
        return send(200, { ok: true, ...r });
      }
      if (url.pathname === "/api/show") {
        deps.show();
        return send(200, { ok: true });
      }
      send(404, { error: "not found" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function cors(req: http.IncomingMessage): Record<string, string> {
  const origin = String(req.headers.origin ?? "");
  if (!/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Lanes-Token, X-Lanes-Extension, X-Prism-Token, X-Prism-Extension",
    Vary: "Origin",
  };
}
