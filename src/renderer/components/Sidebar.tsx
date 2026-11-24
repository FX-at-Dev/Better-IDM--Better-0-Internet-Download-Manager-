import type { AppState, Category } from "../../shared/types";
import { CATEGORIES } from "../../shared/types";
import { CATEGORY_HUE, CATEGORY_LABEL, isActive } from "../lib/format";
import { CATEGORY_ICON, Icon } from "./Icon";

export type Page = "downloads" | "networks" | "scheduler" | "settings";
export type Filter =
  | { kind: "status"; value: "all" | "active" | "queued" | "completed" | "failed" }
  | { kind: "category"; value: Category }
  | { kind: "queue"; value: string };

export function Sidebar({
  state,
  page,
  filter,
  onPage,
  onFilter,
  onAdd,
}: {
  state: AppState;
  page: Page;
  filter: Filter;
  onPage: (p: Page) => void;
  onFilter: (f: Filter) => void;
  onAdd: () => void;
}) {
  const jobs = state.jobs;
  const count = {
    all: jobs.length,
    active: jobs.filter((j) => isActive(j.status)).length,
    queued: jobs.filter((j) => j.status === "queued" || j.status === "scheduled" || j.status === "paused").length,
    completed: jobs.filter((j) => j.status === "completed").length,
    failed: jobs.filter((j) => j.status === "failed").length,
  };
  const is = (f: Filter) => page === "downloads" && filter.kind === f.kind && filter.value === f.value;

  const statusItems: { value: Extract<Filter, { kind: "status" }>["value"]; label: string; icon: string }[] = [
    { value: "all", label: "All downloads", icon: "layers" },
    { value: "active", label: "Downloading", icon: "download" },
    { value: "queued", label: "Waiting", icon: "clock" },
    { value: "completed", label: "Completed", icon: "checkCircle" },
    { value: "failed", label: "Failed", icon: "alert" },
  ];

  const usedCats = CATEGORIES.filter((c) => jobs.some((j) => j.category === c));
  const enabledNets = state.networks.filter((n) => n.enabled && n.present).length;

  return (
    <aside className="sidebar">
      <button className="new-btn" onClick={onAdd}>
        <Icon name="plus" size={16} stroke={2.2} />
        <span>New download</span>
      </button>

      <div className="nav-scroll">
        <nav className="nav">
          {statusItems.map((s) => (
            <button key={s.value} className={`nav-item ${is({ kind: "status", value: s.value }) ? "active" : ""}`} onClick={() => onFilter({ kind: "status", value: s.value })}>
              <Icon name={s.icon} size={16} />
              <span className="label">{s.label}</span>
              {count[s.value] > 0 && <span className={`count ${s.value === "failed" ? "bad" : s.value === "active" ? "live" : ""}`}>{count[s.value]}</span>}
            </button>
          ))}
        </nav>

        {usedCats.length > 0 && (
          <>
            <div className="nav-label">Categories</div>
            <nav className="nav">
              {usedCats.map((c) => (
                <button key={c} className={`nav-item ${is({ kind: "category", value: c }) ? "active" : ""}`} onClick={() => onFilter({ kind: "category", value: c })}>
                  <span className="cat-icon" style={{ color: CATEGORY_HUE[c] }}>
                    <Icon name={CATEGORY_ICON[c]} size={16} />
                  </span>
                  <span className="label">{CATEGORY_LABEL[c]}</span>
                  <span className="count">{jobs.filter((j) => j.category === c).length}</span>
                </button>
              ))}
            </nav>
          </>
        )}

        {state.settings.queues.length > 1 && (
          <>
            <div className="nav-label">Queues</div>
            <nav className="nav">
              {state.settings.queues.map((q) => {
                const n = jobs.filter((j) => j.queueId === q.id && j.status !== "completed").length;
                return (
                  <button key={q.id} className={`nav-item ${is({ kind: "queue", value: q.id }) ? "active" : ""}`} onClick={() => onFilter({ kind: "queue", value: q.id })}>
                    <Icon name={q.schedule.enabled ? "calendar" : "list"} size={16} />
                    <span className="label">{q.name}</span>
                    {n > 0 && <span className="count">{n}</span>}
                  </button>
                );
              })}
            </nav>
          </>
        )}
      </div>

      <nav className="nav nav-bottom">
        <button className={`nav-item ${page === "networks" ? "active" : ""}`} onClick={() => onPage("networks")}>
          <Icon name="wifi" size={16} />
          <span className="label">Networks</span>
          <span className={`count ${enabledNets > 1 ? "live" : ""}`}>{enabledNets}</span>
        </button>
        <button className={`nav-item ${page === "scheduler" ? "active" : ""}`} onClick={() => onPage("scheduler")}>
          <Icon name="calendar" size={16} />
          <span className="label">Scheduler</span>
        </button>
        <button className={`nav-item ${page === "settings" ? "active" : ""}`} onClick={() => onPage("settings")}>
          <Icon name="settings" size={16} />
          <span className="label">Settings</span>
        </button>
      </nav>
    </aside>
  );
}
