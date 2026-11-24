import http from "node:http";
import https from "node:https";
import type { Network } from "./networks.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message?: string,
  ) {
    super(message ?? `Server answered HTTP ${status}`);
  }
}

export interface RequestOptions {
  net?: Network;
  headers?: Record<string, string>;
  method?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface Response {
  res: http.IncomingMessage;
  finalUrl: string;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export function defaultUserAgent(): string {
  return DEFAULT_UA;
}

/** GET (by default) with redirects, an idle timeout and the socket bound to `net`. */
export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  let current = url;
  const max = opts.maxRedirects ?? 10;
  for (let hop = 0; hop <= max; hop++) {
    const res = await once(current, opts);
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.resume();
      res.destroy();
      current = new URL(res.headers.location, current).toString();
      if (!/^https?:/i.test(current)) throw new Error("Redirected to a non-http URL");
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error("Too many redirects");
}

function once(url: string, opts: RequestOptions): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error("Invalid URL"));
    }
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const headers: Record<string, string> = {
      "User-Agent": DEFAULT_UA,
      Accept: "*/*",
      "Accept-Encoding": "identity",
      ...opts.headers,
    };
    const req = lib.request(
      u,
      {
        method: opts.method ?? "GET",
        headers,
        agent: opts.net ? (isHttps ? opts.net.httpsAgent : opts.net.httpAgent) : undefined,
        signal: opts.signal,
      },
      (res) => {
        res.setTimeout(opts.timeoutMs ?? 30_000, () => res.destroy(new Error("Connection stalled (no data for 30 s)")));
        resolve(res);
      },
    );
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error("Connection timed out")));
    req.on("error", reject);
    req.end();
  });
}

export interface ProbeResult {
  size: number; // -1 unknown
  ranges: boolean;
  finalUrl: string;
  disposition?: string;
  contentType?: string;
  etag?: string;
  lastModified?: string;
}

/** Ask for byte 0 to learn the size, range support and validators without downloading the file. */
export async function probe(url: string, opts: RequestOptions): Promise<ProbeResult> {
  const { res, finalUrl } = await request(url, { ...opts, headers: { ...opts.headers, Range: "bytes=0-0" } });
  try {
    const status = res.statusCode ?? 0;
    const h = res.headers;
    const base = {
      finalUrl,
      disposition: str(h["content-disposition"]),
      contentType: str(h["content-type"]),
      etag: str(h["etag"]),
      lastModified: str(h["last-modified"]),
    };
    if (status === 206) {
      const m = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(str(h["content-range"]) ?? "");
      const size = m && m[1] !== "*" ? Number(m[1]) : -1;
      return { ...base, size, ranges: size > 0 };
    }
    if (status === 200) {
      const len = Number(h["content-length"]);
      return { ...base, size: Number.isFinite(len) && h["content-length"] !== undefined ? len : -1, ranges: false };
    }
    if (status === 416) return { ...base, size: 0, ranges: false };
    if (status === 401 || status === 403) throw new HttpError(status, `Access denied (HTTP ${status}) — the link may need a login or has expired`);
    if (status === 404 || status === 410) throw new HttpError(status, `File not found (HTTP ${status})`);
    throw new HttpError(status);
  } finally {
    res.resume();
    res.destroy();
  }
}

function str(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
