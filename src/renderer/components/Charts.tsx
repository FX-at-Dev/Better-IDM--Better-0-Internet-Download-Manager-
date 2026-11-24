import { useEffect, useRef } from "react";
import type { SegmentView } from "../../shared/types";

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      draw(ctx, w, h);
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

function cssVar(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Smooth area chart. Several series are stacked visually as overlapping areas. */
export function AreaChart({
  series,
  height = 120,
  max,
  grid = true,
  className,
}: {
  series: { values: number[]; color: string; label?: string }[];
  height?: number;
  max?: number;
  grid?: boolean;
  className?: string;
}) {
  const key = series.map((s) => s.color + s.values.join(",")).join("|");
  const ref = useCanvas(
    (ctx, w, h) => {
      const N = 60;
      const top = Math.max(1, max ?? 0, ...series.flatMap((s) => s.values)) * 1.15;
      if (grid) {
        ctx.strokeStyle = cssVar("--grid") || "rgba(255,255,255,.06)";
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          const y = Math.round((h * i) / 4) + 0.5;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
      }
      for (const s of series) {
        const vals = s.values.slice(-N);
        if (vals.length < 2 || !vals.some((v) => v > 0)) continue;
        const step = w / (N - 1);
        const x0 = w - (vals.length - 1) * step;
        const pts = vals.map((v, i) => [x0 + i * step, h - (v / top) * (h - 6) - 2] as const);
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          const [px, py] = pts[i - 1];
          const [x, y] = pts[i];
          const cx = (px + x) / 2;
          ctx.bezierCurveTo(cx, py, cx, y, x, y);
        }
        const line = new Path2D();
        line.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          const [px, py] = pts[i - 1];
          const [x, y] = pts[i];
          const cx = (px + x) / 2;
          line.bezierCurveTo(cx, py, cx, y, x, y);
        }
        ctx.lineTo(pts[pts.length - 1][0], h);
        ctx.lineTo(pts[0][0], h);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, withAlpha(s.color, 0.22));
        g.addColorStop(1, withAlpha(s.color, 0));
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.lineJoin = "round";
        ctx.stroke(line);
      }
    },
    [key, max, grid],
  );
  return <canvas ref={ref} className={className} style={{ width: "100%", height }} />;
}

export function Sparkline({ values, color, width = 90, height = 26 }: { values: number[]; color: string; width?: number; height?: number }) {
  const ref = useCanvas(
    (ctx, w, h) => {
      const vals = values.slice(-40);
      if (vals.length < 2) return;
      const top = Math.max(1, ...vals) * 1.2;
      const step = w / 39;
      const x0 = w - (vals.length - 1) * step;
      ctx.beginPath();
      vals.forEach((v, i) => {
        const x = x0 + i * step;
        const y = h - (v / top) * (h - 3) - 1.5;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.lineTo(x0 + (vals.length - 1) * step, h);
      ctx.lineTo(x0, h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, withAlpha(color, 0.25));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.fill();
    },
    [values.join(","), color],
  );
  return <canvas ref={ref} style={{ width, height, display: "block" }} />;
}

/** Thin progress bar that shows each segment's downloaded part in its network's colour. */
export function SegmentBar({
  segments,
  size,
  progress,
  colors,
  accent,
  active,
  height = 6,
}: {
  segments: SegmentView[];
  size: number;
  progress: number;
  colors: Record<string, string>;
  accent: string;
  active: boolean;
  height?: number;
}) {
  const key = segments.map((s) => `${s.start}-${s.end}-${s.done}-${s.net ?? ""}`).join(",");
  const ref = useCanvas(
    (ctx, w, h) => {
      const r = h / 2;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, r);
      ctx.clip();
      ctx.fillStyle = cssVar("--track") || "rgba(255,255,255,.08)";
      ctx.fillRect(0, 0, w, h);
      if (segments.length && size > 0) {
        for (const s of segments) {
          const x = (s.start / size) * w;
          const dw = Math.max(s.done > 0 ? 1 : 0, (s.done / size) * w);
          ctx.fillStyle = s.net && active ? colors[s.net] ?? accent : accent;
          ctx.fillRect(x, 0, dw, h);
        }
      } else {
        ctx.fillStyle = accent;
        ctx.fillRect(0, 0, (progress / 100) * w, h);
      }
      ctx.restore();
    },
    [key, size, progress, active, accent, JSON.stringify(colors)],
  );
  return <canvas ref={ref} className={active ? "segbar live" : "segbar"} style={{ width: "100%", height }} />;
}

/** IDM-style chunk map: a grid of cells, each covering an equal slice of the file. */
export function ChunkMap({
  segments,
  size,
  colors,
  accent,
  done,
}: {
  segments: SegmentView[];
  size: number;
  colors: Record<string, string>;
  accent: string;
  done: boolean;
}) {
  const key = segments.map((s) => `${s.start}-${s.end}-${s.done}-${s.net ?? ""}`).join(",");
  const ref = useCanvas(
    (ctx, w, h) => {
      const cell = 8;
      const gap = 2;
      const cols = Math.max(1, Math.floor((w + gap) / (cell + gap)));
      const rows = Math.max(1, Math.floor((h + gap) / (cell + gap)));
      const n = cols * rows;
      const ox = (w - (cols * (cell + gap) - gap)) / 2;
      const per = size > 0 ? size / n : 1;
      // fill fraction + owning network per cell
      const fill = new Float32Array(n);
      const net: (string | undefined)[] = new Array(n);
      const head = new Uint8Array(n);
      if (done) fill.fill(1);
      else if (size > 0) {
        for (const s of segments) {
          const a = s.start;
          const b = s.start + s.done;
          if (b > a) {
            const c0 = Math.floor(a / per);
            const c1 = Math.min(n - 1, Math.floor((b - 1) / per));
            for (let c = c0; c <= c1; c++) {
              const lo = Math.max(a, c * per);
              const hi = Math.min(b, (c + 1) * per);
              fill[c] += Math.max(0, hi - lo) / per;
              if (s.net) net[c] = s.net;
            }
            if (s.net) head[Math.min(n - 1, Math.floor((b - 1) / per))] = 1;
          } else if (s.net) {
            head[Math.min(n - 1, Math.floor(a / per))] = 1;
            net[Math.min(n - 1, Math.floor(a / per))] = s.net;
          }
        }
      }
      const track = cssVar("--track") || "rgba(255,255,255,.07)";
      for (let i = 0; i < n; i++) {
        const x = ox + (i % cols) * (cell + gap);
        const y = Math.floor(i / cols) * (cell + gap);
        const f = Math.min(1, fill[i]);
        const color = net[i] ? colors[net[i]!] ?? accent : accent;
        ctx.fillStyle = track;
        ctx.beginPath();
        ctx.roundRect(x, y, cell, cell, 2);
        ctx.fill();
        if (f > 0.02) {
          ctx.globalAlpha = f >= 0.999 ? 1 : 0.3 + 0.5 * f;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(x, y, cell, cell, 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        if (head[i]) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(x + 0.75, y + 0.75, cell - 1.5, cell - 1.5, 2);
          ctx.stroke();
        }
      }
    },
    [key, size, done, accent, JSON.stringify(colors)],
  );
  return <canvas ref={ref} style={{ width: "100%", height: 110, display: "block" }} />;
}

export function Ring({ value, size = 64, stroke = 6, color }: { value: number; size?: number; stroke?: number; color: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="ring">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, value / 100))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset .5s ease" }}
      />
    </svg>
  );
}
