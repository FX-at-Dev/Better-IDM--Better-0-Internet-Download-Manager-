import fs from "node:fs";
import crypto from "node:crypto";
import type { HashAlgo } from "../shared/types.js";

const LENGTHS: Record<number, HashAlgo> = { 32: "md5", 40: "sha1", 64: "sha256", 128: "sha512" };

/** Guess the algorithm from a hex digest's length. */
export function algoForDigest(hex: string): HashAlgo | null {
  const clean = normalizeDigest(hex);
  return /^[0-9a-f]+$/.test(clean) ? (LENGTHS[clean.length] ?? null) : null;
}

export function normalizeDigest(hex: string): string {
  return hex.trim().toLowerCase().replace(/^(sha256|sha1|md5|sha512)[:=]\s*/, "").replace(/\s+/g, "");
}

export async function hashFile(
  file: string,
  algo: HashAlgo,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const size = (await fs.promises.stat(file)).size || 1;
  const h = crypto.createHash(algo);
  let read = 0;
  let lastReport = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024, signal });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    h.update(chunk);
    read += chunk.length;
    const now = Date.now();
    if (onProgress && now - lastReport > 200) {
      lastReport = now;
      onProgress(read / size);
    }
  }
  onProgress?.(1);
  return h.digest("hex");
}
