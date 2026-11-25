import type { AppState, CompleteAction, QueueDef } from "../../shared/types";
import { Icon } from "./Icon";
import { Btn, NumberInput, Select, TextInput, Toggle } from "./ui";

const api = window.lanes;
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function SchedulerView({ state }: { state: AppState }) {
  const queues = state.settings.queues;
  const save = (next: QueueDef[]) => api.setSettings({ queues: next });
  const update = (id: string, patch: Partial<QueueDef>) => save(queues.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  const updateSchedule = (q: QueueDef, patch: Partial<QueueDef["schedule"]>) => update(q.id, { schedule: { ...q.schedule, ...patch } });

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Scheduler</h1>
          <div className="sub">Queues run downloads in order. Give one a time window to download overnight or off-peak.</div>
        </div>
        <div className="grow" />
        <Btn
          icon="plus"
          onClick={() =>
            save([
              ...queues,
              {
                id: crypto.randomUUID(),
                name: `Queue ${queues.length + 1}`,
                maxActive: 0,
                schedule: { enabled: true, start: "02:00", stop: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
                onComplete: "none",
              },
            ])
          }
        >
          New queue
        </Btn>
      </div>

      <div className="queue-list">
        {queues.map((q) => {
          const jobs = state.jobs.filter((j) => j.queueId === q.id);
          const waiting = jobs.filter((j) => j.status === "queued" || j.status === "scheduled" || j.status === "paused").length;
          const running = jobs.filter((j) => j.status === "downloading" || j.status === "probing").length;
          return (
            <section key={q.id} className="card queue-card">
              <header className="queue-head">
                <span className="section-icon">
                  <Icon name={q.schedule.enabled ? "calendar" : "list"} size={16} />
                </span>
                <div className="queue-name">
                  {q.id === "main" ? <b>{q.name}</b> : <TextInput value={q.name} onCommit={(v) => update(q.id, { name: v || q.name })} />}
                  <span className="muted small">
                    {running} running · {waiting} waiting
                    {q.schedule.enabled && ` · ${describe(q)}`}
                  </span>
                </div>
                <div className="grow" />
                {q.id !== "main" && <Btn kind="icon" icon="trash" title="Delete queue (its downloads move to the main queue)" onClick={() => {
                  const ids = jobs.map((j) => j.id);
                  if (ids.length) api.moveToQueue(ids, "main");
                  save(queues.filter((x) => x.id !== q.id));
                }} />}
              </header>

              <div className="queue-body">
                <div className="q-field">
                  <label>Run on a schedule</label>
                  <Toggle checked={q.schedule.enabled} onChange={(v) => updateSchedule(q, { enabled: v })} />
                </div>
                <div className={`q-field ${q.schedule.enabled ? "" : "dim"}`}>
                  <label>Start</label>
                  <input type="time" className="text time" value={q.schedule.start} onChange={(e) => updateSchedule(q, { start: e.target.value })} disabled={!q.schedule.enabled} />
                </div>
                <div className={`q-field ${q.schedule.enabled ? "" : "dim"}`}>
                  <label>Stop</label>
                  <div className="row-inline">
                    <input type="time" className="text time" value={q.schedule.stop} onChange={(e) => updateSchedule(q, { stop: e.target.value })} disabled={!q.schedule.enabled} />
                    {q.schedule.stop && q.schedule.enabled && (
                      <button className="link-btn" onClick={() => updateSchedule(q, { stop: "" })}>
                        no stop
                      </button>
                    )}
                  </div>
                </div>
                <div className={`q-field wide ${q.schedule.enabled ? "" : "dim"}`}>
                  <label>Days</label>
                  <div className="days">
                    {DAYS.map((d, i) => (
                      <button
                        key={i}
                        title={DAY_NAMES[i]}
                        disabled={!q.schedule.enabled}
                        className={`day ${q.schedule.days.includes(i) ? "on" : ""}`}
                        onClick={() =>
                          updateSchedule(q, {
                            days: q.schedule.days.includes(i) ? q.schedule.days.filter((x) => x !== i) : [...q.schedule.days, i].sort(),
                          })
                        }
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="q-field">
                  <label>Max at once</label>
                  <NumberInput value={q.maxActive} min={0} max={32} width={80} onCommit={(v) => update(q.id, { maxActive: v })} />
                  <span className="muted small">0 = global ({state.settings.maxActive})</span>
                </div>
                <div className="q-field">
                  <label>When finished</label>
                  <Select<CompleteAction>
                    value={q.onComplete}
                    onChange={(v) => update(q.id, { onComplete: v })}
                    options={[
                      { value: "none", label: "Do nothing" },
                      { value: "quit", label: "Quit Lanes" },
                      { value: "sleep", label: "Sleep the PC" },
                      { value: "shutdown", label: "Shut down the PC" },
                    ]}
                  />
                </div>
              </div>
              {q.onComplete === "shutdown" || q.onComplete === "sleep" ? (
                <div className="muted small q-note">
                  <Icon name="info" size={13} /> You'll get a 60-second countdown with a Cancel button first.
                </div>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function describe(q: QueueDef): string {
  const d = q.schedule.days;
  const days = d.length === 7 ? "every day" : d.length === 5 && !d.includes(0) && !d.includes(6) ? "weekdays" : d.length === 2 && d.includes(0) && d.includes(6) ? "weekends" : d.map((x) => DAY_NAMES[x].slice(0, 3)).join(", ");
  return `${q.schedule.start}${q.schedule.stop ? `–${q.schedule.stop}` : " onward"}, ${days}`;
}
