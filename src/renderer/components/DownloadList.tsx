import { useEffect, useState } from "react";
import type { AddRequest, AppState, JobAction, JobView } from "../../shared/types";
import { ago, bytes, CATEGORY_HUE, CATEGORY_LABEL, eta, hostOf, isActive, percent, speed, STATUS_LABEL } from "../lib/format";
import { SegmentBar } from "./Charts";
import { CATEGORY_ICON, Icon } from "./Icon";
import { Btn, Select } from "./ui";
import type { Filter } from "./Sidebar";
import { ExtensionBanner } from "./Overlays";

const api = window.prism;

type SortKey = "added" | "name" | "size" | "progress" | "order";

export function DownloadList({
  state,
  jobs,
  filter,
  query,
  selected,
  setSelected,
  focusId,
  setFocus,
  colors,
  onAdd,
  toast,
}: {
  state: AppState;
  jobs: JobView[];
  filter: Filter;
  query: string;
  selected: string[];
  setSelected: (ids: string[]) => void;
  focusId: string | null;
  setFocus: (id: string | null) => void;
  colors: Record<string, string>;
  onAdd: (r?: AddRequest) => void;
  toast: (msg: string, icon?: string) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "added", desc: true });
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, []);

  const sorted = [...jobs].sort((a, b) => {
    let d = 0;
    switch (sort.key) {
      case "name":
        d = a.filename.localeCompare(b.filename);
        break;
      case "size":
        d = a.size - b.size;
        break;
      case "progress":
        d = percent(a) - percent(b);
        break;
      case "order":
        d = a.order - b.order;
        break;
      default:
        d = a.createdAt - b.createdAt;
    }
    return sort.desc ? -d : d;
  });

  const click = (e: React.MouseEvent, j: JobView) => {
    if (e.shiftKey && anchor) {
      const ids = sorted.map((x) => x.id);
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(j.id)].sort((x, y) => x - y);
      setSelected(ids.slice(a, b + 1));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected(selected.includes(j.id) ? selected.filter((x) => x !== j.id) : [...selected, j.id]);
      setAnchor(j.id);
    } else {
      setSelected([j.id]);
      setAnchor(j.id);
      setFocus(j.id);
    }
  };

  const act = (ids: string[], a: JobAction) => {
    api.action(ids, a);
    if (a === "copyUrl") toast("Link copied", "copy");
    if (a === "remove" || a === "delete") {
      setSelected([]);
      if (focusId && ids.includes(focusId)) setFocus(null);
    }
  };

  const sel = jobs.filter((j) => selected.includes(j.id));
  const title =
    filter.kind === "status"
      ? { all: "All downloads", active: "Downloading", queued: "Waiting", completed: "Completed", failed: "Failed" }[filter.value]
      : filter.kind === "category"
        ? CATEGORY_LABEL[filter.value]
        : (state.settings.queues.find((q) => q.id === filter.value)?.name ?? "Queue");

  const anyRunning = jobs.some((j) => isActive(j.status) || j.status === "queued");
  const anyStopped = jobs.some((j) => j.status === "paused" || j.status === "failed");
  const showExt = !state.settings.extensionDismissed && state.apiListening && state.settings.extensionBrowsers.length === 0;
  const header = (key: SortKey, label: string, cls: string) => (
    <button className={`th ${cls} ${sort.key === key ? "sorted" : ""}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
      {label}
      {sort.key === key && <Icon name={sort.desc ? "chevronDown" : "chevronUp"} size={12} stroke={2.2} />}
    </button>
  );

  return (
    <div className="list-page">
      <div className="page-head">
        <div className="page-title">
          <h1>{title}</h1>
          <span className="sub">
            {jobs.length} {jobs.length === 1 ? "item" : "items"}
            {state.totals.active > 0 && ` · ${state.totals.active} active`}
          </span>
        </div>
        <div className="grow" />
        {sel.length > 0 ? (
          <div className="toolbar">
            <span className="sel-count">{sel.length} selected</span>
            <Btn small icon="play" onClick={() => act(selected, "resume")}>
              Resume
            </Btn>
            <Btn small icon="pause" onClick={() => act(selected, "pause")}>
              Pause
            </Btn>
            {state.settings.queues.length > 1 && (
              <Select
                small
                value=""
                options={[{ value: "", label: "Move to queue" }, ...state.settings.queues.map((q) => ({ value: q.id, label: q.name }))]}
                onChange={(q) => q && api.moveToQueue(selected, q)}
              />
            )}
            <Btn small kind="icon" icon="trash" title="Remove from list" onClick={() => act(selected, "remove")} />
            <Btn small kind="icon" icon="x" title="Clear selection" onClick={() => setSelected([])} />
          </div>
        ) : (
          <div className="toolbar">
            {anyStopped && (
              <Btn small icon="play" onClick={() => api.resumeAll()}>
                Resume all
              </Btn>
            )}
            {anyRunning && (
              <Btn small icon="pause" onClick={() => api.pauseAll()}>
                Pause all
              </Btn>
            )}
            {filter.kind === "status" && filter.value === "completed" && jobs.length > 0 && (
              <Btn small icon="trash" onClick={() => api.clearCompleted()}>
                Clear list
              </Btn>
            )}
          </div>
        )}
      </div>

      {showExt && <ExtensionBanner />}

      {sorted.length === 0 ? (
        <Empty filter={filter} searching={!!query.trim()} onAdd={() => onAdd()} />
      ) : (
        <div className="table" role="grid">
          <div className="thead">
            {header("name", "Name", "c-name")}
            {header("size", "Size", "c-size")}
            {header("progress", "Status", "c-status")}
            <span className="th c-speed">Speed</span>
            <span className="th c-eta">Time left</span>
            {header("added", "Added", "c-added")}
            <span className="th c-actions" />
          </div>
          <div className="tbody" onClick={(e) => e.target === e.currentTarget && setSelected([])}>
            {sorted.map((j) => (
              <JobRow
                key={j.id}
                j={j}
                selected={selected.includes(j.id)}
                focused={focusId === j.id}
                colors={colors}
                accent={state.settings.accent}
                onClick={(e) => click(e, j)}
                onDouble={() => (j.status === "completed" ? act([j.id], "open") : act([j.id], isActive(j.status) ? "pause" : "resume"))}
                onContext={(e) => {
                  e.preventDefault();
                  const ids = selected.includes(j.id) ? selected : [j.id];
                  if (!selected.includes(j.id)) setSelected([j.id]);
                  setMenu({ x: Math.min(e.clientX, innerWidth - 232), y: Math.min(e.clientY, innerHeight - 360), ids });
                }}
                act={act}
              />
            ))}
          </div>
        </div>
      )}

      {menu && <ContextMenu menu={menu} jobs={jobs} state={state} act={act} close={() => setMenu(null)} />}
    </div>
  );
}

export function FileIcon({ category, size = 32 }: { category: JobView["category"]; size?: number }) {
  return (
    <span className="file-icon" style={{ ["--hue" as string]: CATEGORY_HUE[category], width: size, height: size }}>
      <Icon name={CATEGORY_ICON[category]} size={Math.round(size * 0.5)} />
    </span>
  );
}

function subline(j: JobView): { text: string; tone?: "bad" | "warn" } {
  if (j.error && j.status !== "completed") return { text: j.error, tone: "bad" };
  if (j.note) return { text: j.note };
  if (j.checksum?.state === "mismatch") return { text: "Checksum doesn't match the expected hash", tone: "warn" };
  const parts: string[] = [];
  if (j.kind === "media") parts.push(hostOf(j.url), j.media?.quality ?? "");
  else if (j.kind === "torrent") parts.push(j.torrent && isActive(j.status) ? `${j.torrent.peers} peers` : "Torrent");
  else parts.push(hostOf(j.url));
  const nets = Object.keys(j.perNet).filter((k) => j.perNet[k].speed > 0).length;
  if (nets > 1) parts.push(`${nets} networks`);
  if (j.status === "merging") parts.push(j.media?.parts && j.media.parts > 1 ? "Joining video and audio" : "Converting");
  if (j.checksum?.state === "ok") parts.push(`${j.checksum.algo.toUpperCase()} verified`);
  return { text: parts.filter(Boolean).join(" · ") };
}

function JobRow({
  j,
  selected,
  focused,
  colors,
  accent,
  onClick,
  onDouble,
  onContext,
  act,
}: {
  j: JobView;
  selected: boolean;
  focused: boolean;
  colors: Record<string, string>;
  accent: string;
  onClick: (e: React.MouseEvent) => void;
  onDouble: () => void;
  onContext: (e: React.MouseEvent) => void;
  act: (ids: string[], a: JobAction) => void;
}) {
  const pct = percent(j);
  const active = isActive(j.status);
  const sub = subline(j);
  const barColor = j.status === "paused" ? "var(--text-3)" : accent;
  const findingPeers = j.kind === "torrent" && j.status === "downloading" && j.size <= 0;
  const showBar = !findingPeers && (j.status === "downloading" || j.status === "paused" || j.status === "probing" || j.status === "merging");

  return (
    <div
      className={`tr ${selected ? "selected" : ""} ${focused ? "focused" : ""} st-${j.status}`}
      role="row"
      aria-selected={selected}
      onClick={onClick}
      onDoubleClick={onDouble}
      onContextMenu={onContext}
    >
      <div className="td c-name">
        <FileIcon category={j.category} />
        <div className="name-stack">
          <span className="fname" title={j.filename}>
            {j.filename}
          </span>
          <span className={`sub ${sub.tone ?? ""}`} title={sub.text}>
            {sub.text}
          </span>
        </div>
      </div>
      <div className="td c-size num">{j.status === "completed" ? bytes(j.size) : j.size > 0 ? bytes(j.size) : "—"}</div>
      <div className="td c-status">
        {showBar ? (
          <div className="progress">
            <SegmentBar segments={j.segments} size={j.kind === "media" ? -1 : j.size} progress={pct} colors={colors} accent={j.status === "paused" ? "#8b919c" : barColor} active={active} height={4} />
            <span className="pct num">{j.status === "probing" ? "…" : j.status === "merging" ? "Merging" : j.size > 0 ? `${Math.floor(pct)}%` : bytes(j.downloaded)}</span>
          </div>
        ) : (
          <span className={`state s-${j.status}`}>
            {j.status === "completed" && <Icon name={j.checksum?.state === "mismatch" ? "alert" : "check"} size={13} stroke={2.2} />}
            {j.status === "failed" && <Icon name="alert" size={13} />}
            {findingPeers ? "Finding peers…" : STATUS_LABEL[j.status]}
            {j.status === "verifying" && j.checksum?.progress !== undefined && ` ${Math.round(j.checksum.progress * 100)}%`}
          </span>
        )}
      </div>
      <div className="td c-speed num">{active && j.speed > 0 ? speed(j.speed) : ""}</div>
      <div className="td c-eta num">{active && j.eta >= 0 ? eta(j.eta) : ""}</div>
      <div className="td c-added">{ago(j.completedAt ?? j.createdAt)}</div>
      <div className="td c-actions" onClick={(e) => e.stopPropagation()}>
        {active || j.status === "queued" || j.status === "scheduled" ? (
          <Btn kind="icon" small icon="pause" title="Pause" onClick={() => act([j.id], "pause")} />
        ) : j.status === "completed" ? (
          <Btn kind="icon" small icon="external" title="Open" onClick={() => act([j.id], "open")} />
        ) : (
          <Btn kind="icon" small icon={j.status === "failed" ? "refresh" : "play"} title={j.status === "failed" ? "Retry" : "Resume"} onClick={() => act([j.id], "resume")} />
        )}
        <Btn kind="icon" small icon="folder" title="Show in folder" onClick={() => act([j.id], "reveal")} />
      </div>
    </div>
  );
}

function ContextMenu({
  menu,
  jobs,
  state,
  act,
  close,
}: {
  menu: { x: number; y: number; ids: string[] };
  jobs: JobView[];
  state: AppState;
  act: (ids: string[], a: JobAction) => void;
  close: () => void;
}) {
  const list = jobs.filter((j) => menu.ids.includes(j.id));
  const one = list.length === 1 ? list[0] : null;
  const anyActive = list.some((j) => isActive(j.status) || j.status === "queued" || j.status === "scheduled");
  const anyStopped = list.some((j) => j.status === "paused" || j.status === "failed");
  const item = (icon: string, label: string, a: JobAction, danger = false, hint?: string) => (
    <button
      className={`menu-item ${danger ? "danger" : ""}`}
      onClick={() => {
        act(menu.ids, a);
        close();
      }}
    >
      <Icon name={icon} size={15} />
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  );
  return (
    <div className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      {one?.status === "completed" && item("external", "Open", "open")}
      {item("folderOpen", "Show in folder", "reveal")}
      {item("copy", "Copy link", "copyUrl")}
      <div className="menu-sep" />
      {anyActive && item("pause", "Pause", "pause", false, "Space")}
      {anyStopped && item("play", "Resume", "resume", false, "Space")}
      {item("refresh", "Restart from scratch", "restart")}
      {list.some((j) => j.status === "completed") && item("shield", "Verify checksum", "verify")}
      {item("arrowUp", "Move to top of queue", "top")}
      {state.settings.queues.length > 1 && (
        <>
          <div className="menu-sep" />
          <div className="menu-label">Move to queue</div>
          {state.settings.queues.map((q) => (
            <button
              key={q.id}
              className="menu-item"
              onClick={() => {
                api.moveToQueue(menu.ids, q.id);
                close();
              }}
            >
              <Icon name={one?.queueId === q.id ? "check" : "list"} size={15} />
              <span>{q.name}</span>
            </button>
          ))}
        </>
      )}
      <div className="menu-sep" />
      {item("x", "Remove from list", "remove", false, "Del")}
      {item("trash", "Delete file", "delete", true, "Shift+Del")}
    </div>
  );
}

function Empty({ filter, searching, onAdd }: { filter: Filter; searching: boolean; onAdd: () => void }) {
  const isAll = filter.kind === "status" && filter.value === "all" && !searching;
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={searching ? "search" : "download"} size={26} />
      </div>
      <h2>{searching ? "No matches" : isAll ? "No downloads yet" : "Nothing here"}</h2>
      <p>
        {searching
          ? "Try a different file name or site."
          : isAll
            ? "Paste a link to a file or a video page, drop a .torrent file, or let the browser extension send downloads here."
            : "Downloads that match this view will show up here."}
      </p>
      {isAll && (
        <div className="empty-actions">
          <Btn kind="primary" icon="plus" onClick={onAdd}>
            New download
          </Btn>
          <span className="hint">
            or press <kbd>Ctrl+V</kbd> with a link copied
          </span>
        </div>
      )}
    </div>
  );
}
