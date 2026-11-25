// Renders the Lanes app icon to PNG without any image libraries.
// A blue rounded tile with a white lanes and a download arrow.
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const TOP = hex("#5f9bff");
const BOTTOM = hex("#3466e0");


function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x) - half + r;
  const qy = Math.abs(y) - half + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}
function inTriangle(px, py, a, b, c) {
  const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const p = [px, py];
  const d1 = s(p, a, b),
    d2 = s(p, b, c),
    d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// The Lanes mark: three lanes that merge into one arrow pointing down, over a base line.
const LANES = [
  [0.3, 0.2, 0.5, 0.64],
  [0.5, 0.2, 0.5, 0.64],
  [0.7, 0.2, 0.5, 0.64],
  [0.31, 0.8, 0.69, 0.8],
];

/** Blue rounded tile with the white Lanes mark. */
function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 4;
  const w = size <= 20 ? 0.075 : size <= 48 ? 0.06 : 0.048; // stroke half-width, bolder when small
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (sdRoundRect(u - 0.5, v - 0.5, 0.47, 0.2) >= 0) continue;
          let col = mix(TOP, BOTTOM, v);
          if (Math.min(...LANES.map(([ax, ay, bx, by]) => segDist(u, v, ax, ay, bx, by))) < w) col = [255, 255, 255];
          acc[0] += col[0];
          acc[1] += col[1];
          acc[2] += col[2];
          acc[3] += 1;
        }
      }
      const i = (y * size + x) * 4;
      const alpha = acc[3] / (SS * SS);
      out[i] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      out[i + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      out[i + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, size, out);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(root, "assets"), { recursive: true });
fs.writeFileSync(path.join(root, "assets", "icon.png"), render(512));
fs.writeFileSync(path.join(root, "assets", "tray.png"), render(32));
fs.writeFileSync(path.join(root, "assets", "tray@2x.png"), render(64));
for (const s of [16, 32, 48, 128]) {
  fs.mkdirSync(path.join(root, "extension", "src", "icons"), { recursive: true });
  fs.writeFileSync(path.join(root, "extension", "src", "icons", `${s}.png`), render(s));
}
console.log("icons written");
