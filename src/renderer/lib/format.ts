import type { Category, JobStatus, JobView } from "../../shared/types";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytes(n: number, digits = 1): string {
  if (n < 0 || !Number.isFinite(n)) return "—";
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}

export function speed(n: number): string {
  return n > 0 ? `${bytes(n)}/s` : "0 B/s";
}

export function splitSpeed(n: number): [string, string] {
  const s = speed(n);
  const i = s.indexOf(" ");
  return [s.slice(0, i), s.slice(i + 1)];
}

export function eta(sec: number): string {
  if (sec < 0 || !Number.isFinite(sec)) return "";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export function ago(ts: number): string {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function percent(j: JobView): number {
  if (j.status === "completed") return 100;
  if (j.size <= 0) return 0;
  return Math.min(100, (j.downloaded / j.size) * 100);
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  scheduled: "Scheduled",
  probing: "Connecting",
  downloading: "Downloading",
  paused: "Paused",
  merging: "Merging",
  verifying: "Verifying",
  seeding: "Seeding",
  completed: "Completed",
  failed: "Failed",
};

export const CATEGORY_LABEL: Record<Category, string> = {
  video: "Videos",
  audio: "Music",
  documents: "Documents",
  archives: "Compressed",
  programs: "Programs",
  images: "Images",
  torrents: "Torrents",
  other: "Others",
};

export const CATEGORY_HUE: Record<Category, string> = {
  video: "#e5679a",
  audio: "#e0a32e",
  documents: "#4f8cff",
  archives: "#a776f0",
  programs: "#2fb67c",
  images: "#35b5c9",
  torrents: "#e07b4f",
  other: "#8b919c",
};

/** "2:05", "1:02:09" */
export function duration(sec?: number): string {
  if (!sec || sec < 0) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toUpperCase() : "";
}

export const isActive = (s: JobStatus) => s === "downloading" || s === "probing" || s === "merging" || s === "seeding" || s === "verifying";
