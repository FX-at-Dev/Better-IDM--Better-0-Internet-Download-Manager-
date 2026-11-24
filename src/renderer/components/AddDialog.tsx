import { useEffect, useMemo, useRef, useState } from "react";
import type { AddRequest, AddResult, AppState, Category, HashAlgo, Inspection, MediaInfo, MediaOption } from "../../shared/types";
import { CATEGORY_FOLDER } from "../../shared/types";
import { bytes, duration } from "../lib/format";
import { FileIcon } from "./DownloadList";
import { Icon } from "./Icon";
import { Btn, Select, Toggle } from "./ui";

const api = window.prism;

const isLink = (u: string) => /^(https?:\/\/\S+|magnet:\?\S+)$/i.test(u);

function pickDefault(options: MediaOption[], pref: string): MediaOption | undefined {
  if (pref === "audio") return options.find((o) => o.id === "audio") ?? options[0];
  const videos = options.filter((o) => !o.audioOnly);
  if (/^\d+$/.test(pref)) return videos.find((o) => o.height <= Number(pref)) ?? videos[videos.length - 1] ?? options[0];
  return videos[0] ?? options[0];
}

type Probe = { url: string; loading: boolean; result?: Inspection };

export function AddDialog({
  state,
  request,
  onClose,
  onAdded,
}: {
  state: AppState;
  request: AddRequest;
  onClose: () => void;
  onAdded: (n: number, msg?: string) => void;
}) {
  const s = state.settings;
  const [text, setText] = useState(request.urls.join("\n"));
  const [probe, setProbe] = useState<Probe | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [asFile, setAsFile] = useState(false);
  const [dir, setDir] = useState("");
  const [filename, setFilename] = useState(request.filename ?? "");
  const [queueId, setQueueId] = useState("main");
  const [paused, setPaused] = useState(false);
  const [connections, setConnections] = useState(0);
  const [hashAlgo, setHashAlgo] = useState<HashAlgo>("sha256");
  const [hash, setHash] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddResult | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const headers = { cookie: request.cookie, referer: request.referer, ua: request.ua };

  // focus, clipboard autofill, Esc
  useEffect(() => {
    input.current?.focus();
    if (!request.urls.length) {
      navigator.clipboard
        .readText()
        .then((t) => {
          const urls = t.split(/\s+/).filter(isLink);
          if (urls.length) setText((cur) => cur || urls.join("\n"));
        })
        .catch(() => {});
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const urls = useMemo(
    () =>
      text
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    [text],
  );
  const valid = urls.filter(isLink);
  const invalid = urls.length - valid.length;
  const single = valid.length === 1 && invalid === 0 ? valid[0] : null;

  // inspect a single link: file info, or the video's qualities
  const inspect = (url: string) => {
    setProbe({ url, loading: true });
    setAsFile(false);
    api
      .inspect(url, headers)
      .then((r) => setProbe((p) => (p?.url === url ? { url, loading: false, result: r } : p)))
      .catch((e) => setProbe((p) => (p?.url === url ? { url, loading: false, result: { kind: "error", message: String(e?.message ?? e), canDownloadAnyway: true } } : p)));
  };
  useEffect(() => {
    if (!single) return setProbe(null);
    if (probe?.url === single) return;
    const t = setTimeout(() => inspect(single), 250);
    return () => clearTimeout(t);
  }, [single]);

  // after yt-dlp finishes installing, try the link again
  useEffect(() => {
    if (state.tools.ytdlp && probe?.result?.kind === "needs-ytdlp") inspect(probe.url);
  }, [state.tools.ytdlp]);

  const r = probe?.result;
  const media: MediaInfo | null = r?.kind === "media" && !asFile ? r.info : null;
  useEffect(() => {
    if (media) setChoice(pickDefault(media.options, s.defaultQuality)?.id ?? "");
  }, [media?.url, media?.title]);
  const option = media?.options.find((o) => o.id === choice);
  useEffect(() => {
    if (r?.kind === "file" && !request.filename) setFilename(r.name);
  }, [r]);

  const waiting = !!single && (!probe || probe.loading || probe.url !== single);
  const blocked = !!single && !waiting && !asFile && (r?.kind === "needs-ytdlp" || (r?.kind === "error" && !r.canDownloadAnyway) || (r?.kind === "media" && !option));
  const canSubmit = valid.length > 0 && !busy && !waiting && !blocked && !(r?.kind === "error" && !asFile && single);

  const submit = async (allowDuplicates = false) => {
    if (!canSubmit && !allowDuplicates) return;
    setBusy(true);
    const common = {
      dir: dir || undefined,
      queueId,
      paused,
      connections: connections || undefined,
      checksum: hash.trim() ? { algo: hashAlgo, value: hash } : undefined,
      allowDuplicates,
      cookie: request.cookie,
      referer: request.referer,
      ua: request.ua,
    };
    let res: AddResult;
    if (media && option) {
      const fmt = {
        format: option.format,
        label: option.label,
        height: option.height,
        ext: option.ext,
        stream: option.stream,
        audioOnly: option.audioOnly,
        convert: option.convert,
      };
      if (media.playlist) res = await api.add({ urls: media.playlist.entries, format: fmt, ...common, checksum: undefined });
      else res = await api.add({ urls: [media.url], format: { ...fmt, size: option.size, title: media.title, thumbnail: media.thumbnail }, filename: filename.trim() || undefined, ...common });
    } else {
      res = await api.add({
        urls: valid,
        media: asFile ? false : request.media,
        quality: s.defaultQuality,
        filename: single && filename.trim() ? filename.trim() : undefined,
        ...common,
      });
    }
    setBusy(false);
    if (res.added.length) onAdded(res.added.length, media?.playlist ? `Added ${res.added.length} videos` : undefined);
    if (res.duplicates.length || res.errors.length) setResult(res);
    else onClose();
  };

  // where it will land: Downloads\Videos, Downloads\Images, … (site rules can still override)
  const cat: Category | null = media ? (option?.audioOnly ? "audio" : "video") : r?.kind === "file" ? r.category : r?.kind === "torrent" ? "torrents" : null;
  const sep = s.downloadDir.includes("/") && !s.downloadDir.includes("\\") ? "/" : "\\";
  const pathLabel = dir || (s.categorize && cat ? s.downloadDir.replace(/[\\/]+$/, "") + sep + CATEGORY_FOLDER[cat] : s.downloadDir);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal add-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <header className="modal-head">
          <h2>New download</h2>
          <Btn kind="icon" small icon="x" title="Close (Esc)" onClick={onClose} />
        </header>

        <div className="modal-body">
          <div className={`url-field ${valid.length > 1 || text.includes("\n") ? "multi" : ""}`}>
            <Icon name="link" size={15} />
            <textarea
              ref={input}
              value={text}
              rows={valid.length > 1 || text.includes("\n") ? 4 : 1}
              onChange={(e) => {
                setText(e.target.value);
                setResult(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !text.includes("\n")) {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Enter" && e.ctrlKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Paste a link to a file, a video page, or a magnet link"
              spellCheck={false}
            />
            {!text && (
              <button
                type="button"
                className="paste-btn"
                onClick={async () => {
                  const t = await navigator.clipboard.readText().catch(() => "");
                  const urls = t.split(/\s+/).filter(isLink);
                  if (urls.length) setText(urls.join("\n"));
                }}
              >
                Paste
              </button>
            )}
          </div>
          <div className="url-hint">
            {valid.length > 1 ? (
              <span>
                {valid.length} links{invalid > 0 && <span className="bad"> · {invalid} not a link</span>}
              </span>
            ) : invalid > 0 ? (
              <span className="bad">That doesn't look like a link.</span>
            ) : (
              <span>Files, video pages (YouTube and 1,000+ sites) and magnet links</span>
            )}
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                const p = await api.pickTorrent();
                if (!p) return;
                const res = await api.addTorrentFile(p, { dir: dir || undefined, queueId });
                if (res.added.length) {
                  onAdded(1, "Torrent added");
                  onClose();
                }
              }}
            >
              Open .torrent file
            </button>
          </div>

          {single && <Preview probe={probe} single={single} state={state} asFile={asFile} setAsFile={setAsFile} choice={choice} setChoice={setChoice} retry={() => inspect(single)} />}

          {result && (result.duplicates.length > 0 || result.errors.length > 0) && (
            <div className="callout warn">
              <Icon name="alert" size={16} />
              <div className="grow">
                {result.duplicates.length > 0 && <div>{result.duplicates.length === 1 ? `Already in your list: ${result.duplicates[0].filename}` : `${result.duplicates.length} of these links are already in your list.`}</div>}
                {result.errors.map((e) => (
                  <div key={e} className="muted">
                    {e}
                  </div>
                ))}
              </div>
              {result.duplicates.length > 0 && (
                <Btn small onClick={() => submit(true)}>
                  Download again
                </Btn>
              )}
            </div>
          )}

          <div className="form-grid">
            {single && (r?.kind === "file" || (media && !media.playlist)) && (
              <label className="field span-2">
                <span>File name</span>
                <input
                  className="text"
                  value={filename}
                  placeholder={media ? `${media.title}.${option?.ext ?? "mp4"}` : "Automatic"}
                  onChange={(e) => setFilename(e.target.value)}
                  spellCheck={false}
                />
              </label>
            )}
            <div className="field">
              <span>Save to</span>
              <button type="button" className="path-btn" title={pathLabel} onClick={async () => setDir((await api.pickFolder(dir || s.downloadDir)) ?? dir)}>
                <Icon name="folder" size={15} />
                <span className="path-text">{pathLabel}</span>
                {!dir && s.categorize && !cat && <span className="path-note">sorted by type</span>}
              </button>
            </div>
            <div className="field">
              <span>Queue</span>
              <Select
                value={queueId}
                onChange={setQueueId}
                options={s.queues.map((q) => ({ value: q.id, label: q.name + (q.schedule.enabled ? ` · starts ${q.schedule.start}` : "") }))}
              />
            </div>
          </div>

          <button type="button" className="disclosure" onClick={() => setMore(!more)} aria-expanded={more}>
            <Icon name={more ? "chevronDown" : "chevronRight"} size={14} />
            Advanced
          </button>
          {more && (
            <div className="form-grid">
              <div className="field">
                <span>Connections per network</span>
                <Select
                  value={String(connections)}
                  onChange={(v) => setConnections(Number(v))}
                  options={[{ value: "0", label: `Default (${s.connectionsPerNetwork})` }, ...[1, 2, 4, 8, 12, 16, 24, 32].map((n) => ({ value: String(n), label: String(n) }))]}
                />
              </div>
              <div className="field">
                <span>Checksum algorithm</span>
                <Select<HashAlgo>
                  value={hashAlgo}
                  onChange={setHashAlgo}
                  options={[
                    { value: "sha256", label: "SHA-256" },
                    { value: "sha1", label: "SHA-1" },
                    { value: "md5", label: "MD5" },
                    { value: "sha512", label: "SHA-512" },
                  ]}
                />
              </div>
              <label className="field span-2">
                <span>Expected checksum</span>
                <input className="text mono" placeholder="Optional — verified when the download finishes" value={hash} onChange={(e) => setHash(e.target.value)} spellCheck={false} />
              </label>
            </div>
          )}
        </div>

        <footer className="modal-foot">
          <label className="check">
            <Toggle checked={paused} onChange={setPaused} label="Add without starting" />
            <span>Don't start yet</span>
          </label>
          <div className="grow" />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" type="submit" icon="download" disabled={!canSubmit}>
            {busy ? "Adding…" : paused ? "Add" : media?.playlist ? `Download ${media.playlist.count} videos` : valid.length > 1 ? `Download ${valid.length}` : "Download"}
          </Btn>
        </footer>
      </form>
    </div>
  );
}

function Preview({
  probe,
  single,
  state,
  asFile,
  setAsFile,
  choice,
  setChoice,
  retry,
}: {
  probe: Probe | null;
  single: string;
  state: AppState;
  asFile: boolean;
  setAsFile: (v: boolean) => void;
  choice: string;
  setChoice: (id: string) => void;
  retry: () => void;
}) {
  if (!probe || probe.loading || probe.url !== single)
    return (
      <div className="preview loading">
        <span className="spin">
          <Icon name="spinner" size={18} stroke={2} />
        </span>
        <div>
          <b>Checking link…</b>
          <span className="muted">Looking for the file or the video's available qualities</span>
        </div>
      </div>
    );
  const r = probe.result!;
  if (asFile)
    return (
      <div className="preview">
        <FileIcon category="other" size={40} />
        <div className="preview-text">
          <b>Download the link as a file</b>
          <span className="muted">Prism will save whatever the server sends.</span>
        </div>
        <Btn small onClick={() => setAsFile(false)}>
          Undo
        </Btn>
      </div>
    );
  switch (r.kind) {
    case "file":
      return (
        <div className="preview">
          <FileIcon category={r.category} size={40} />
          <div className="preview-text">
            <b title={r.name}>{r.name}</b>
            <span className="muted">
              {r.size > 0 ? bytes(r.size) : "Unknown size"}
              {r.type && ` · ${r.type.split(";")[0]}`}
            </span>
          </div>
          <span className={`tag ${r.resumable ? "ok" : ""}`} title={r.resumable ? "The server supports resuming and multi-connection downloads" : "The server sends the file in one piece"}>
            {r.resumable ? "Resumable" : "Single connection"}
          </span>
        </div>
      );
    case "torrent":
      return (
        <div className="preview">
          <FileIcon category="torrents" size={40} />
          <div className="preview-text">
            <b>{r.name}</b>
            <span className="muted">Torrent · files are listed once peers are found</span>
          </div>
        </div>
      );
    case "needs-ytdlp":
      return (
        <div className="preview">
          <FileIcon category="video" size={40} />
          <div className="preview-text">
            <b>This looks like a video page{r.site ? ` on ${r.site}` : ""}</b>
            <span className="muted">Prism reads video sites with yt-dlp, a free tool (about 25 MB, installed once).</span>
          </div>
          <Btn kind="primary" small disabled={!!state.tools.installing} onClick={() => api.installTool("ytdlp")}>
            {state.tools.installing === "ytdlp" ? state.tools.message || "Installing…" : "Install yt-dlp"}
          </Btn>
        </div>
      );
    case "error":
      return (
        <div className="preview error">
          <span className="preview-glyph bad">
            <Icon name="alert" size={18} />
          </span>
          <div className="preview-text">
            <b>Couldn't read this link</b>
            <span className="muted">{r.message}</span>
          </div>
          <div className="preview-actions">
            <Btn small onClick={retry}>
              Try again
            </Btn>
            {r.canDownloadAnyway && (
              <Btn small onClick={() => setAsFile(true)}>
                Download as file
              </Btn>
            )}
          </div>
        </div>
      );
    case "media":
      return <QualityPicker info={r.info} state={state} choice={choice} setChoice={setChoice} />;
  }
}

function QualityPicker({ info, state, choice, setChoice }: { info: MediaInfo; state: AppState; choice: string; setChoice: (id: string) => void }) {
  const [thumbOk, setThumbOk] = useState(true);
  const videos = info.options.filter((o) => !o.audioOnly);
  const audios = info.options.filter((o) => o.audioOnly);
  const sel = info.options.find((o) => o.id === choice);
  const row = (o: MediaOption) => (
    <label key={o.id} className={`q-option ${choice === o.id ? "on" : ""}`}>
      <input type="radio" name="quality" checked={choice === o.id} onChange={() => setChoice(o.id)} />
      <span className="q-radio" />
      <span className="q-label">{o.label}</span>
      <span className="q-detail">{o.detail}</span>
      <span className="q-size num">{o.size > 0 ? `${info.playlist ? "" : "~"}${bytes(o.size)}` : ""}</span>
    </label>
  );
  return (
    <div className="media-preview">
      <div className="media-head">
        <div className="thumb">
          {info.thumbnail && thumbOk ? <img src={info.thumbnail} alt="" onError={() => setThumbOk(false)} /> : <Icon name={info.playlist ? "list" : "video"} size={22} />}
          {info.duration ? <span className="thumb-time num">{duration(info.duration)}</span> : null}
        </div>
        <div className="media-meta">
          <b title={info.title}>{info.title}</b>
          <span className="muted">
            {[info.site, info.uploader, info.playlist ? `${info.playlist.count} videos` : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>

      <div className="q-list" role="radiogroup" aria-label="Quality">
        {videos.length > 0 && <div className="q-group">Video</div>}
        {videos.map(row)}
        {audios.length > 0 && <div className="q-group">Audio only</div>}
        {audios.map(row)}
      </div>

      {sel?.needsFfmpeg && !state.tools.ffmpeg && (
        <div className="note">
          <Icon name="info" size={14} />
          <span>
            {sel.convert ? "Converting to MP3" : "This quality comes as separate video and audio. Joining them"} needs ffmpeg — Prism installs it automatically the first time (about 90 MB).
          </span>
        </div>
      )}
      {sel?.stream && (
        <div className="note">
          <Icon name="info" size={14} />
          <span>This site streams video in small pieces, so it downloads over one network instead of all of them.</span>
        </div>
      )}
    </div>
  );
}
