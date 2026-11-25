import { useEffect, useState } from "react";
import type { AppState, HashAlgo, JobView } from "../../shared/types";
import { ago, bytes, CATEGORY_LABEL, eta, isActive, percent, speed, STATUS_LABEL } from "../lib/format";
import { AreaChart, ChunkMap, SegmentBar } from "./Charts";
import { FileIcon } from "./DownloadList";
import { Icon } from "./Icon";
import { Btn, Select } from "./ui";

const api = window.lanes;

export function DetailPanel({ job: j, state, colors, onClose }: { job: JobView; state: AppState; colors: Record<string, string>; onClose: () => void }) {
  const pct = percent(j);
  const active = isActive(j.status);
  const accent = state.settings.accent;
  const netShares = Object.entries(j.perNet).sort((a, b) => b[1].bytes - a[1].bytes);
  const totalShare = netShares.reduce((a, [, v]) => a + v.bytes, 0) || 1;
  const netName = (id: string) => state.networks.find((n) => n.id === id)?.name ?? id;

  return (
    <aside className="detail" key={j.id}>
      <div className="detail-head">
        {j.media?.thumbnail ? <img className="detail-thumb" src={j.media.thumbnail} alt="" /> : <FileIcon category={j.category} size={36} />}
        <div className="detail-title">
          <h2 title={j.filename}>{j.filename}</h2>
          <span className={`state s-${j.status}`}>
            {STATUS_LABEL[j.status]}
            {j.media && j.media.parts > 1 && j.status === "downloading" && <span className="muted"> · part {j.media.partIndex + 1} of {j.media.parts}</span>}
          </span>
        </div>
        <Btn kind="icon" small icon="x" title="Close" onClick={onClose} />
      </div>

      <div className="detail-scroll">
        {j.status !== "completed" && (
          <div className="progress-block">
            <div className="progress-top">
              <span className="big num">{j.size > 0 ? `${Math.floor(pct)}%` : bytes(j.downloaded)}</span>
              <span className="muted num">{active && j.speed > 0 ? speed(j.speed) : ""}</span>
            </div>
            <SegmentBar segments={j.segments} size={j.kind === "media" ? -1 : j.size} progress={pct} colors={colors} accent={j.status === "failed" ? "#e5534b" : accent} active={active} height={6} />
          </div>
        )}
        <dl className="stats">
          <div>
            <dt>{j.status === "completed" ? "Size" : "Downloaded"}</dt>
            <dd className="num">{j.status === "completed" ? bytes(j.size) : `${bytes(j.downloaded)}${j.size > 0 ? ` of ${bytes(j.size)}` : ""}`}</dd>
          </div>
          <div>
            <dt>{j.status === "completed" ? "Finished" : "Time left"}</dt>
            <dd className="num">{j.status === "completed" ? ago(j.completedAt ?? j.createdAt) : active && j.eta >= 0 ? eta(j.eta) : "—"}</dd>
          </div>
          {j.kind !== "torrent" && (
            <div>
              <dt>Connections</dt>
              <dd className="num">{active ? j.connections : "—"}</dd>
            </div>
          )}
          {j.kind === "media" && (
            <div>
              <dt>Quality</dt>
              <dd>{j.media?.quality}</dd>
            </div>
          )}
        </dl>

        {j.error && j.status !== "completed" && (
          <div className="callout bad">
            <Icon name="alert" size={16} />
            <span>{j.error}</span>
          </div>
        )}

        <div className="actions-row">
          {active || j.status === "queued" || j.status === "scheduled" ? (
            <Btn icon="pause" small onClick={() => api.action([j.id], "pause")}>
              Pause
            </Btn>
          ) : j.status === "completed" ? (
            <Btn kind="primary" icon="external" small onClick={() => api.action([j.id], "open")}>
              Open file
            </Btn>
          ) : (
            <Btn kind="primary" icon={j.status === "failed" ? "refresh" : "play"} small onClick={() => api.action([j.id], "resume")}>
              {j.status === "failed" ? "Retry" : "Resume"}
            </Btn>
          )}
          <Btn icon="folderOpen" small onClick={() => api.action([j.id], "reveal")}>
            Show in folder
          </Btn>
          <div className="grow" />
          <Btn kind="icon" icon="copy" small title="Copy link" onClick={() => api.action([j.id], "copyUrl")} />
          <Btn kind="icon" icon="refresh" small title="Restart from scratch" onClick={() => api.action([j.id], "restart")} />
        </div>

        {j.kind !== "torrent" && j.status !== "completed" && (j.size > 0 || j.segments.length > 0) && (
          <div className="block">
            <div className="block-head">
              <h4>Chunk map</h4>
              <span className="muted">{j.segments.length} segments{j.connections ? ` · ${j.connections} live` : ""}</span>
            </div>
            <div className="inset">
              <ChunkMap segments={j.segments} size={segSize(j)} colors={colors} accent={accent} done={false} />
            </div>
          </div>
        )}

        {j.history.length > 1 && (
        <div className="block">
          <div className="block-head">
            <h4>Speed</h4>
            <span className="muted num">peak {speed(Math.max(0, ...j.history))}</span>
          </div>
          <div className="inset">
            <AreaChart series={[{ values: j.history, color: accent }]} height={80} />
          </div>
        </div>
        )}

        {netShares.length > 0 && (
          <div className="block">
            <div className="block-head">
              <h4>Networks</h4>
              <span className="muted">share of this download</span>
            </div>
            <div className="share-bar">
              {netShares.map(([id, v]) => (
                <span key={id} style={{ width: `${(v.bytes / totalShare) * 100}%`, background: colors[id] }} />
              ))}
            </div>
            <div className="share-list">
              {netShares.map(([id, v]) => (
                <div key={id} className="share-item">
                  <i style={{ background: colors[id] }} />
                  <span>{netName(id)}</span>
                  <span className="grow" />
                  <span className="num muted">{bytes(v.bytes)}</span>
                  <span className="num">{speed(v.speed)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {j.torrent && (
          <div className="block">
            <div className="block-head">
              <h4>Torrent</h4>
            </div>
            <dl className="facts">
              <dt>Peers</dt>
              <dd className="num">{j.torrent.peers}</dd>
              <dt>Uploaded</dt>
              <dd className="num">
                {bytes(j.torrent.uploaded)} · ratio {j.torrent.ratio.toFixed(2)}
              </dd>
              <dt>Upload speed</dt>
              <dd className="num">{speed(j.torrent.upSpeed)}</dd>
              {j.torrent.infoHash && (
                <>
                  <dt>Info hash</dt>
                  <dd className="mono small">{j.torrent.infoHash}</dd>
                </>
              )}
            </dl>
          </div>
        )}

        <ChecksumBlock j={j} />

        <div className="block">
          <div className="block-head">
            <h4>Details</h4>
          </div>
          <dl className="facts">
            <dt>Source</dt>
            <dd className="link" title={j.url}>
              {j.url}
            </dd>
            <dt>Saved to</dt>
            <dd className="link" title={j.path || j.dir} onClick={() => api.action([j.id], "reveal")}>
              {j.path || j.dir}
            </dd>
            <dt>Category</dt>
            <dd>{CATEGORY_LABEL[j.category]}</dd>
            <dt>Queue</dt>
            <dd>
              <Select small value={j.queueId} options={state.settings.queues.map((q) => ({ value: q.id, label: q.name }))} onChange={(q) => api.moveToQueue([j.id], q)} />
            </dd>
            <dt>Added</dt>
            <dd>{ago(j.createdAt)}</dd>
            {j.completedAt && (
              <>
                <dt>Finished</dt>
                <dd>{ago(j.completedAt)}</dd>
              </>
            )}
            <dt>Resume</dt>
            <dd>{j.resumable ? "Supported" : "Not supported by server"}</dd>
          </dl>
        </div>
      </div>
    </aside>
  );
}

function segSize(j: JobView): number {
  if (!j.segments.length) return j.size;
  return Math.max(...j.segments.map((s) => s.end));
}

function ChecksumBlock({ j }: { j: JobView }) {
  const cs = j.checksum;
  const [algo, setAlgo] = useState<HashAlgo>(cs?.algo ?? "sha256");
  const [expected, setExpected] = useState(cs?.expected ?? "");
  useEffect(() => {
    setExpected(j.checksum?.expected ?? "");
    if (j.checksum?.algo) setAlgo(j.checksum.algo);
  }, [j.id, j.checksum?.expected, j.checksum?.algo]);

  const state = cs?.state;
  return (
    <div className="block">
      <div className="block-head">
        <h4>Checksum</h4>
        {state === "ok" && (
          <span className="badge ok">
            <Icon name="shield" size={12} /> Match
          </span>
        )}
        {state === "mismatch" && (
          <span className="badge warn">
            <Icon name="alert" size={12} /> Mismatch
          </span>
        )}
      </div>
      <div className="checksum">
        <div className="cs-row">
          <Select<HashAlgo>
            small
            value={algo}
            onChange={setAlgo}
            options={[
              { value: "sha256", label: "SHA-256" },
              { value: "sha1", label: "SHA-1" },
              { value: "md5", label: "MD5" },
              { value: "sha512", label: "SHA-512" },
            ]}
          />
          <input className="text mono" placeholder="Expected hash (optional)" value={expected} onChange={(e) => setExpected(e.target.value)} spellCheck={false} />
        </div>
        <div className="cs-row">
          <Btn small icon="shield" disabled={state === "running"} onClick={() => api.setChecksum(j.id, algo, expected)}>
            {j.status === "completed" ? "Verify" : "Verify when done"}
          </Btn>
          {state === "running" && <span className="muted num">Hashing… {Math.round((cs?.progress ?? 0) * 100)}%</span>}
          {state === "error" && <span className="muted">File not found</span>}
        </div>
        {cs?.actual && (
          <div className="hash-out mono" title="Click to copy" onClick={() => navigator.clipboard.writeText(cs.actual!)}>
            <span className="muted">{cs.algo.toUpperCase()}</span> {cs.actual}
          </div>
        )}
      </div>
    </div>
  );
}
