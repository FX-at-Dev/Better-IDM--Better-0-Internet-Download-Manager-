import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AddRequest, AppState, ClipboardOffer, JobView, Settings } from "../shared/types";
import { Sidebar, type Filter, type Page } from "./components/Sidebar";
import { DownloadList } from "./components/DownloadList";
import { DetailPanel } from "./components/DetailPanel";
import { AddDialog } from "./components/AddDialog";
import { NetworksView } from "./components/NetworksView";
import { SchedulerView } from "./components/SchedulerView";
import { SettingsView } from "./components/SettingsView";
import { Titlebar } from "./components/Titlebar";
import { ClipboardToast, ShutdownBanner, Toasts, useToasts } from "./components/Overlays";
import { Icon } from "./components/Icon";
import { isActive } from "./lib/format";

const api = window.lanes;

function useAppState(): AppState | null {
  const [s, setS] = useState<AppState | null>(null);
  useEffect(() => {
    api.getState().then(setS);
    return api.onState(setS);
  }, []);
  return s;
}

function applyTheme(s: Settings) {
  const root = document.documentElement;
  const theme = s.theme === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : s.theme;
  root.dataset.theme = theme;
  root.dataset.refraction = s.refraction && theme === "glass" ? "on" : "off";
  root.dataset.compact = s.compact ? "on" : "off";
  root.style.setProperty("--accent", s.accent);
  root.style.setProperty("--tint", String(s.glassTint / 100));
}

const linksIn = (text: string) => text.split(/\s+/).filter((u) => /^(https?:\/\/|magnet:\?)/i.test(u));

export function App() {
  const state = useAppState();
  const [page, setPage] = useState<Page>("downloads");
  const [filter, setFilter] = useState<Filter>({ kind: "status", value: "all" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [addReq, setAddReq] = useState<(AddRequest & { key: number }) | null>(null);
  const [clip, setClip] = useState<ClipboardOffer | null>(null);
  const [dragging, setDragging] = useState(false);
  const toasts = useToasts();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state) applyTheme(state.settings);
  }, [state?.settings]);

  // a fresh key remounts the dialog, so a link from the extension replaces whatever was open
  const openAdd = useCallback((r: AddRequest = { urls: [] }) => setAddReq({ ...r, urls: r.urls ?? [], key: Date.now() }), []);

  useEffect(() => api.onClipboard(setClip), []);
  useEffect(() => api.onFocusAdd((r) => openAdd(r)), [openAdd]);

  const jobs = state?.jobs ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs.filter((j) => {
      if (q && !j.filename.toLowerCase().includes(q) && !j.url.toLowerCase().includes(q)) return false;
      if (filter.kind === "category") return j.category === filter.value;
      if (filter.kind === "queue") return j.queueId === filter.value && j.status !== "completed";
      switch (filter.value) {
        case "active":
          return isActive(j.status);
        case "queued":
          return j.status === "queued" || j.status === "scheduled" || j.status === "paused";
        case "completed":
          return j.status === "completed";
        case "failed":
          return j.status === "failed";
        default:
          return true;
      }
    });
  }, [jobs, filter, query]);

  const focused: JobView | undefined = jobs.find((j) => j.id === focusId);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement)?.closest("input, textarea, select");
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "n") {
        e.preventDefault();
        openAdd();
      } else if (e.ctrlKey && k === "f") {
        e.preventDefault();
        setPage("downloads");
        searchRef.current?.focus();
      } else if (inField || addReq) {
        return;
      } else if (e.ctrlKey && k === "v") {
        const urls = linksIn(await navigator.clipboard.readText().catch(() => ""));
        if (urls.length) openAdd({ urls });
      } else if (e.ctrlKey && k === "a" && page === "downloads") {
        e.preventDefault();
        setSelected(visible.map((j) => j.id));
      } else if (e.key === "Delete" && selected.length) {
        api.action(selected, e.shiftKey ? "delete" : "remove");
        setSelected([]);
      } else if (e.key === " " && selected.length) {
        e.preventDefault();
        const anyActive = jobs.some((j) => selected.includes(j.id) && isActive(j.status));
        api.action(selected, anyActive ? "pause" : "resume");
      } else if (e.key === "Escape") {
        setSelected([]);
        setFocusId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, visible, jobs, page, addReq, openAdd]);

  // drag & drop links and .torrent files anywhere
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const drop = async (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      let added = 0;
      for (const f of [...(e.dataTransfer?.files ?? [])]) {
        if (!/\.torrent$/i.test(f.name)) continue;
        const r = await api.addTorrentFile(api.pathForFile(f));
        added += r.added.length;
      }
      if (added) toasts.push(`Added ${added} torrent${added > 1 ? "s" : ""}`, "magnet");
      const urls = linksIn(e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "");
      if (urls.length) openAdd({ urls });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [openAdd, toasts]);

  if (!state) return <div className="boot" />;

  const colors = Object.fromEntries(state.networks.map((n) => [n.id, n.color]));
  const showDetail = !!focused && page === "downloads";

  return (
    <>
      {state.settings.refraction && <LiquidFilter />}
      <div className="app">
        <Titlebar
          state={state}
          query={query}
          setQuery={(q) => {
            setQuery(q);
            setPage("downloads");
          }}
          searchRef={searchRef}
        />
        <Sidebar
          state={state}
          page={page}
          filter={filter}
          onPage={setPage}
          onFilter={(f) => {
            setFilter(f);
            setPage("downloads");
            setSelected([]);
          }}
          onAdd={() => openAdd()}
        />
        <div className={`content ${showDetail ? "with-detail" : ""}`}>
          <main className="main">
            {state.pendingShutdown && <ShutdownBanner p={state.pendingShutdown} />}
            {page === "downloads" && (
              <DownloadList
                state={state}
                jobs={visible}
                filter={filter}
                query={query}
                selected={selected}
                setSelected={setSelected}
                focusId={focusId}
                setFocus={setFocusId}
                colors={colors}
                onAdd={openAdd}
                toast={toasts.push}
              />
            )}
            {page === "networks" && <NetworksView state={state} />}
            {page === "scheduler" && <SchedulerView state={state} />}
            {page === "settings" && <SettingsView state={state} toast={toasts.push} />}
          </main>
          {showDetail && <DetailPanel job={focused!} state={state} colors={colors} onClose={() => setFocusId(null)} />}
        </div>
      </div>
      {addReq && (
        <AddDialog
          key={addReq.key}
          state={state}
          request={addReq}
          onClose={() => setAddReq(null)}
          onAdded={(n, what) => toasts.push(what ?? `Added ${n} download${n > 1 ? "s" : ""}`, "download")}
        />
      )}
      {clip && !addReq && (
        <ClipboardToast
          offer={clip}
          onDismiss={() => setClip(null)}
          onDownload={async () => {
            setClip(null);
            if (clip.kind === "media") return openAdd({ urls: [clip.url], media: true });
            await api.add({ urls: [clip.url], allowDuplicates: true, source: "clipboard" });
            toasts.push("Download added", "download");
          }}
          onCustomize={() => {
            openAdd({ urls: [clip.url] });
            setClip(null);
          }}
        />
      )}
      {dragging && (
        <div className="dropzone">
          <div className="dropcard">
            <Icon name="download" size={28} />
            <div>Drop links or .torrent files</div>
          </div>
        </div>
      )}
      <Toasts items={toasts.items} />
    </>
  );
}

/** Edge refraction for floating glass (dialogs, menus) — used through backdrop-filter: url(#liquid). */
function LiquidFilter() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <filter id="liquid" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.008 0.012" numOctaves="2" seed="4" result="noise" />
        <feGaussianBlur in="noise" stdDeviation="3" result="soft" />
        <feDisplacementMap in="SourceGraphic" in2="soft" scale="24" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
