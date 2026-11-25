import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState, ClipboardOffer } from "../../shared/types";
import { Icon } from "./Icon";
import { Btn } from "./ui";

const api = window.lanes;

interface Toast {
  id: number;
  msg: string;
  icon: string;
}

export function useToasts() {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((msg: string, icon = "check") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, msg, icon }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 2600);
  }, []);
  return useMemo(() => ({ items, push }), [items, push]);
}

export function Toasts({ items }: { items: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          <Icon name={t.icon} size={15} />
          {t.msg}
        </div>
      ))}
    </div>
  );
}

export function ClipboardToast({
  offer,
  onDownload,
  onCustomize,
  onDismiss,
}: {
  offer: ClipboardOffer;
  onDownload: () => void;
  onCustomize: () => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 12000);
    return () => clearTimeout(t);
  }, [offer.url]);
  const media = offer.kind === "media";
  return (
    <div className="clip-toast" role="dialog" aria-label="Copied link">
      <span className="clip-icon">
        <Icon name={offer.kind === "torrent" ? "magnet" : media ? "video" : "clipboard"} size={16} />
      </span>
      <div className="clip-text">
        <span className="muted small">{media ? "Copied a video link" : "Copied a download link"}</span>
        <b title={offer.url}>{offer.name}</b>
      </div>
      <Btn kind="primary" small onClick={onDownload}>
        {media ? "Choose quality" : "Download"}
      </Btn>
      {!media && <Btn kind="icon" small icon="sliders" title="Options" onClick={onCustomize} />}
      <Btn kind="icon" small icon="x" title="Dismiss" onClick={onDismiss} />
      <div className="clip-timer" />
    </div>
  );
}

export function ShutdownBanner({ p }: { p: NonNullable<AppState["pendingShutdown"]> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((p.at - now) / 1000));
  const verb = { shutdown: "Shutting down", sleep: "Going to sleep", quit: "Closing Lanes", none: "" }[p.action];
  return (
    <div className="banner warn">
      <Icon name="power" size={16} />
      <div className="grow">
        <b>
          {verb} in {left}s
        </b>
        <span className="muted"> — “{p.queue}” finished.</span>
      </div>
      <Btn kind="primary" small onClick={() => api.cancelShutdown()}>
        Cancel
      </Btn>
    </div>
  );
}

/** Shown when an update is downloaded, or found and waiting for a click. */
export function UpdateBanner({ u, onHide }: { u: AppState["update"]; onHide: () => void }) {
  const ready = u.state === "ready";
  return (
    <div className="banner">
      <Icon name="arrowUp" size={16} />
      <div className="grow">
        <b>{ready ? `Lanes ${u.version} is ready` : `Lanes ${u.version} is available`}</b>
        <span className="muted">
          {ready ? " — it installs when you quit Lanes, or restart now." : u.mode === "auto" ? " — download it in the background." : " — get it from the download page."}
        </span>
      </div>
      {ready ? (
        <Btn kind="primary" small onClick={() => api.installUpdate()}>
          Restart now
        </Btn>
      ) : (
        <Btn kind="primary" small onClick={() => api.downloadUpdate()}>
          {u.mode === "auto" ? "Download" : "Get it"}
        </Btn>
      )}
      <Btn kind="icon" small icon="x" title="Later" onClick={onHide} />
    </div>
  );
}

export function ExtensionBanner() {
  return (
    <div className="banner">
      <Icon name="puzzle" size={16} />
      <div className="grow">
        <b>Add Lanes to your browser</b>
        <span className="muted"> — catch every download automatically and get a download button on videos, like IDM.</span>
      </div>
      <Btn kind="primary" small onClick={() => api.openSetupPage()}>
        Set up extension
      </Btn>
      <Btn kind="icon" small icon="x" title="Hide" onClick={() => api.setSettings({ extensionDismissed: true })} />
    </div>
  );
}
