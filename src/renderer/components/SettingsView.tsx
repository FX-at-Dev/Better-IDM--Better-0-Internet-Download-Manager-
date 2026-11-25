import type { AppState, Category, HashAlgo, Settings, SiteRule, ThemeName } from "../../shared/types";
import { CATEGORIES } from "../../shared/types";
import { CATEGORY_LABEL } from "../lib/format";
import { Icon } from "./Icon";
import { Btn, NumberInput, Row, Section, Select, Slider, TextInput, Toggle } from "./ui";

const api = window.lanes;
const ACCENTS = ["#4f8cff", "#2fb67c", "#35b5c9", "#a776f0", "#e5679a", "#e07b4f", "#e0a32e", "#8b919c"];

export function SettingsView({ state, toast }: { state: AppState; toast: (m: string, i?: string) => void }) {
  const s = state.settings;
  const set = (patch: Partial<Settings>) => api.setSettings(patch);
  const rules = s.rules;
  const setRules = (r: SiteRule[]) => set({ rules: r });

  return (
    <div className="page settings">
      <div className="page-head">
        <div className="page-title">
          <h1>Settings</h1>
          <span className="sub">Lanes {state.version}</span>
        </div>
      </div>

      <Section title="Appearance" icon="palette">
        <div className="themes">
          {(
            [
              ["glass", "Liquid Glass", "Translucent, shows your desktop"],
              ["dark", "Dark", "Solid dark"],
              ["light", "Light", "Solid light"],
              ["auto", "System", "Follows Windows"],
            ] as [ThemeName, string, string][]
          ).map(([id, name, desc]) => (
            <button key={id} className={`theme-card ${s.theme === id ? "on" : ""}`} onClick={() => set({ theme: id })}>
              <div className={`theme-preview tp-${id}`}>
                <i />
                <i />
                <i />
              </div>
              <b>{name}</b>
              <span className="muted small">{desc}</span>
            </button>
          ))}
        </div>
        <Row title="Accent colour">
          <div className="swatches">
            {ACCENTS.map((c) => (
              <button key={c} className={`swatch ${s.accent === c ? "on" : ""}`} style={{ background: c }} onClick={() => set({ accent: c })} aria-label={c} />
            ))}
            <label className="swatch custom" title="Custom colour">
              <input type="color" value={s.accent} onChange={(e) => set({ accent: e.target.value })} />
              <Icon name="plus" size={14} />
            </label>
          </div>
        </Row>
        {s.theme === "glass" && (
          <>
            <Row title="Glass opacity" help="How much of your desktop shows through the window.">
              <div className="slider-wrap">
                <span className="muted small">Clear</span>
                <Slider value={s.glassTint} onChange={(v) => set({ glassTint: v })} />
                <span className="muted small">Solid</span>
              </div>
            </Row>
            <Row title="Liquid refraction" help="Dialogs and menus bend what's behind them, like real glass.">
              <Toggle checked={s.refraction} onChange={(v) => set({ refraction: v })} />
            </Row>
          </>
        )}
        <Row title="Compact list" help="Shorter rows, more downloads on screen.">
          <Toggle checked={s.compact} onChange={(v) => set({ compact: v })} />
        </Row>
      </Section>

      <Section title="General" icon="settings">
        <Row title="Download folder" help={s.categorize ? "Files are sorted into Videos, Music, Images, Documents, Compressed, Programs, Torrents and Others inside it." : undefined}>
          <button className="path-btn" onClick={async () => {
            const p = await api.pickFolder(s.downloadDir);
            if (p) set({ downloadDir: p });
          }}>
            <Icon name="folder" size={15} />
            <span>{s.downloadDir}</span>
          </button>
        </Row>
        <Row title="Sort into folders by file type" help="Turn off to save everything straight into the download folder.">
          <Toggle checked={s.categorize} onChange={(v) => set({ categorize: v })} />
        </Row>
        <Row title="Simultaneous downloads">
          <NumberInput value={s.maxActive} min={1} max={32} onCommit={(v) => set({ maxActive: v })} />
        </Row>
        <Row title="Resume unfinished downloads on start">
          <Toggle checked={s.autoResume} onChange={(v) => set({ autoResume: v })} />
        </Row>
        <Row title="Start when the computer starts" help="Lanes waits quietly in the tray, so downloads from your browser are caught right away.">
          <Toggle checked={s.autoStart} onChange={(v) => set({ autoStart: v })} />
        </Row>
        <Row title="Keep running in the tray when closed">
          <Toggle checked={s.closeToTray} onChange={(v) => set({ closeToTray: v })} />
        </Row>
        <Row title="Notify when downloads finish">
          <Toggle checked={s.notifyComplete} onChange={(v) => set({ notifyComplete: v })} />
        </Row>
        <Row title="Catch copied links" help="Offers to download when you copy a link to a file or a magnet link.">
          <Toggle checked={s.clipboardWatch} onChange={(v) => set({ clipboardWatch: v })} />
        </Row>
      </Section>

      <UpdatesSection state={state} />

      <Section title="Speed & connections" icon="gauge">
        <Row title="Connections per network" help="Each enabled network opens this many parallel connections per download.">
          <NumberInput value={s.connectionsPerNetwork} min={1} max={32} onCommit={(v) => set({ connectionsPerNetwork: v })} />
        </Row>
        <Row title="Global speed limit" help="0 = unlimited. Per-network caps are on the Networks page.">
          <NumberInput value={s.globalLimitKBps} min={0} suffix="KB/s" width={130} onCommit={(v) => set({ globalLimitKBps: v })} />
        </Row>
        <Row title="Smallest segment" help="Segments are never split below this size.">
          <NumberInput value={s.minSegmentKB} min={64} max={65536} suffix="KB" width={120} onCommit={(v) => set({ minSegmentKB: v })} />
        </Row>
        <Row title="Retries per network" help="Consecutive failures before a network sits a download out.">
          <NumberInput value={s.retries} min={1} max={50} onCommit={(v) => set({ retries: v })} />
        </Row>
      </Section>

      <Section title="Smart naming & duplicates" icon="sparkle">
        <Row title="When a link is already in the list">
          <Select
            value={s.duplicateAction}
            onChange={(v) => set({ duplicateAction: v })}
            options={[
              { value: "ask", label: "Ask me" },
              { value: "rename", label: "Download again" },
              { value: "skip", label: "Skip it" },
            ]}
          />
        </Row>
        <Row title="When the file already exists" help="Rename adds (1), (2)… to the new file.">
          <Select
            value={s.existingFileAction}
            onChange={(v) => set({ existingFileAction: v })}
            options={[
              { value: "rename", label: "Rename the new file" },
              { value: "overwrite", label: "Overwrite" },
            ]}
          />
        </Row>
        <Row title="Custom user agent" help="Leave empty to look like a regular browser.">
          <TextInput value={s.userAgent} placeholder="Default" onCommit={(v) => set({ userAgent: v })} />
        </Row>
      </Section>

      <Section
        title="Site rules"
        icon="rules"
        aside={
          <Btn
            small
            icon="plus"
            onClick={() => setRules([...rules, { id: crypto.randomUUID(), enabled: true, match: "*.example.com", folder: "", category: "", queueId: "", connections: 0 }])}
          >
            Add rule
          </Btn>
        }
      >
        <p className="muted small section-note">Send downloads from certain sites to their own folder, queue or connection count. Patterns match host names: <code>*.github.com</code>, <code>cdn*.site.io</code>.</p>
        {rules.length === 0 ? (
          <div className="muted small empty-rules">No rules yet.</div>
        ) : (
          <div className="rules">
            {rules.map((r) => {
              const up = (p: Partial<SiteRule>) => setRules(rules.map((x) => (x.id === r.id ? { ...x, ...p } : x)));
              return (
                <div key={r.id} className="rule">
                  <Toggle checked={r.enabled} onChange={(v) => up({ enabled: v })} />
                  <TextInput value={r.match} mono onCommit={(v) => up({ match: v })} />
                  <button className="path-btn small" onClick={async () => {
                    const p = await api.pickFolder(r.folder || s.downloadDir);
                    if (p) up({ folder: p });
                  }}>
                    <Icon name="folder" size={14} />
                    <span>{r.folder || "Default folder"}</span>
                  </button>
                  <Select<Category | "">
                    small
                    value={r.category}
                    onChange={(v) => up({ category: v })}
                    options={[{ value: "", label: "Auto category" }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))]}
                  />
                  <Select small value={r.queueId} onChange={(v) => up({ queueId: v })} options={[{ value: "", label: "Main queue" }, ...s.queues.filter((q) => q.id !== "main").map((q) => ({ value: q.id, label: q.name }))]} />
                  <Select
                    small
                    value={String(r.connections)}
                    onChange={(v) => up({ connections: Number(v) })}
                    options={[{ value: "0", label: "Default conns" }, ...[1, 2, 4, 8, 16].map((n) => ({ value: String(n), label: `${n} conn` }))]}
                  />
                  <Btn kind="icon" small icon="trash" title="Delete rule" onClick={() => setRules(rules.filter((x) => x.id !== r.id))} />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Checksums" icon="shield">
        <Row title="Hash every finished download" help="Shows the hash in the details panel. Downloads with an expected hash are always verified.">
          <Toggle checked={s.autoHash} onChange={(v) => set({ autoHash: v })} />
        </Row>
        <Row title="Algorithm">
          <Select<HashAlgo>
            value={s.hashAlgo}
            onChange={(v) => set({ hashAlgo: v })}
            options={[
              { value: "sha256", label: "SHA-256" },
              { value: "sha1", label: "SHA-1" },
              { value: "md5", label: "MD5" },
              { value: "sha512", label: "SHA-512" },
            ]}
          />
        </Row>
      </Section>

      <Section
        title="Browser extension"
        icon="puzzle"
        aside={
          !state.apiListening ? (
            <span className="tag warn">Not listening</span>
          ) : s.extensionBrowsers.length ? (
            <span className="tag ok">Connected · {s.extensionBrowsers.join(", ")}</span>
          ) : (
            <span className="tag">Not installed yet</span>
          )
        }
      >
        <div className="ext-install">
          <p className="muted small">
            Like IDM's browser integration: it catches downloads, adds a <b>Download video</b> button on videos (YouTube and others) that opens the quality picker here, and
            adds “Download with Lanes” to the right-click menu.
          </p>
          <div className="row-inline">
            <Btn kind={s.extensionBrowsers.length ? "secondary" : "primary"} small icon="puzzle" onClick={() => api.openSetupPage()}>
              {s.extensionBrowsers.length ? "Add to another browser" : "Set up extension"}
            </Btn>
            <span className="muted small">Opens a step-by-step page in your default browser. To use another browser, open the page there:</span>
            <code className="token" style={{ maxWidth: "none" }}>{`http://127.0.0.1:${s.apiPort}/welcome`}</code>
          </div>
        </div>
        <Row title="Take over browser downloads">
          <Toggle checked={s.intercept} onChange={(v) => set({ intercept: v })} />
        </Row>
        <Row title="Show the download window" help="Caught downloads open the same window as a pasted link: name, size, folder and queue. Off: they start straight away. Videos always ask for a quality.">
          <Toggle checked={s.downloadDialog} onChange={(v) => set({ downloadDialog: v })} />
        </Row>
        <Row title="Only take over files larger than" help="Small files stay in the browser.">
          <NumberInput value={s.interceptMinMB} min={0} suffix="MB" width={100} onCommit={(v) => set({ interceptMinMB: v })} />
        </Row>
        <Row title="Local port" help="Change it in the extension's popup too.">
          <NumberInput value={s.apiPort} min={1024} max={65535} onCommit={(v) => set({ apiPort: v })} />
        </Row>
        <Row title="Extension token" help="Optional. When set, the extension must send the same token.">
          <div className="row-inline">
            <code className="token">{s.apiToken || "none"}</code>
            <Btn
              small
              onClick={async () => {
                const t = await api.newToken();
                navigator.clipboard.writeText(t);
                toast("Token copied", "copy");
              }}
            >
              Generate
            </Btn>
            {s.apiToken && (
              <Btn small onClick={() => set({ apiToken: "" })}>
                Clear
              </Btn>
            )}
          </div>
        </Row>
      </Section>

      <Section title="Video sites & torrents" icon="video">
        <Row title="yt-dlp" help="Reads YouTube, Vimeo, X, Instagram, TikTok and 1,000+ other sites.">
          <ToolStatus path={state.tools.ytdlp} busy={state.tools.installing === "ytdlp"} msg={state.tools.message} onInstall={() => api.installTool("ytdlp")} />
        </Row>
        <Row title="ffmpeg" help="Joins separate video and audio, converts to MP3. Installed automatically when first needed.">
          <ToolStatus path={state.tools.ffmpeg} busy={state.tools.installing === "ffmpeg"} msg={state.tools.message} onInstall={() => api.installTool("ffmpeg")} />
        </Row>
        <Row title="Preselected video quality" help="The quality picker starts on this one.">
          <Select
            value={s.defaultQuality}
            onChange={(v) => set({ defaultQuality: v })}
            options={[
              { value: "best", label: "Best" },
              { value: "2160", label: "4K" },
              { value: "1080", label: "1080p" },
              { value: "720", label: "720p" },
              { value: "480", label: "480p" },
              { value: "audio", label: "Audio only" },
            ]}
          />
        </Row>
        <Row title="Use cookies from browser" help="Helps with “Sign in to confirm you're not a bot” and members-only videos.">
          <Select
            value={s.cookiesFromBrowser}
            onChange={(v) => set({ cookiesFromBrowser: v })}
            options={[
              { value: "", label: "Off" },
              { value: "edge", label: "Edge" },
              { value: "chrome", label: "Chrome" },
              { value: "firefox", label: "Firefox" },
              { value: "brave", label: "Brave" },
            ]}
          />
        </Row>
        <Row title="Seed torrents until ratio" help="0 = stop as soon as the download completes.">
          <NumberInput value={s.seedRatio} min={0} max={100} onCommit={(v) => set({ seedRatio: v })} />
        </Row>
      </Section>

      <div className="settings-foot">
        <Btn small icon="refresh" onClick={async () => {
          await api.resetSettings();
          toast("Settings reset");
        }}>
          Reset to defaults
        </Btn>
      </div>
    </div>
  );
}

function UpdatesSection({ state }: { state: AppState }) {
  const u = state.update;
  const s = state.settings;
  if (u.mode === "off") return null;
  const status =
    u.state === "checking"
      ? "Checking for updates…"
      : u.state === "latest"
        ? "You have the latest version."
        : u.state === "available"
          ? `Lanes ${u.version} is available.`
          : u.state === "downloading"
            ? `Downloading Lanes ${u.version}… ${u.percent ?? 0}%`
            : u.state === "ready"
              ? `Lanes ${u.version} is downloaded. It installs when you quit Lanes, or restart now.`
              : u.state === "error"
                ? u.error || "Couldn't check for updates."
                : "Lanes checks for new versions every few hours.";
  return (
    <Section title="Updates" icon="arrowUp">
      {u.mode === "auto" ? (
        <Row
          title="Download updates automatically"
          help="New versions download in the background and install the next time Lanes restarts. When off, Lanes just tells you a new version is out."
        >
          <Toggle checked={s.autoUpdate} onChange={(v) => api.setSettings({ autoUpdate: v })} />
        </Row>
      ) : (
        <Row
          title="Update notices"
          help={
            state.platform === "darwin"
              ? "On macOS Lanes can't install updates by itself yet (that needs a signed app), so it tells you when a new version is out."
              : "This copy (portable or package) can't replace itself, so Lanes tells you when a new version is out."
          }
        >
          <span className="muted">On</span>
        </Row>
      )}
      <Row title={`Lanes ${state.version}`} help={status}>
        <UpdateButton u={u} />
      </Row>
    </Section>
  );
}

function UpdateButton({ u }: { u: AppState["update"] }) {
  if (u.state === "ready")
    return (
      <Btn kind="primary" small icon="refresh" onClick={() => api.installUpdate()}>
        Restart now
      </Btn>
    );
  if (u.state === "available")
    return (
      <Btn kind="primary" small icon={u.mode === "auto" ? "download" : "external"} onClick={() => api.downloadUpdate()}>
        {u.mode === "auto" ? "Download" : "Get it"}
      </Btn>
    );
  if (u.state === "downloading") return <span className="muted">{u.percent ?? 0}%</span>;
  return (
    <Btn small icon="refresh" disabled={u.state === "checking"} onClick={() => api.checkForUpdates()}>
      {u.state === "checking" ? "Checking…" : "Check now"}
    </Btn>
  );
}

function ToolStatus({ path, busy, msg, onInstall }: { path: string | null; busy: boolean; msg?: string; onInstall: () => void }) {
  if (path)
    return (
      <span className="tool-ok" title={path}>
        <Icon name="checkCircle" size={15} /> Ready
      </span>
    );
  return (
    <Btn small icon="download" disabled={busy} onClick={onInstall}>
      {busy ? msg || "Installing…" : "Install"}
    </Btn>
  );
}
