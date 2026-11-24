import type { RefObject } from "react";
import type { AppState } from "../../shared/types";
import { speed } from "../lib/format";
import { Icon } from "./Icon";

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="logo" aria-hidden="true">
      <path d="M12 2.5 22 20.5H2z" fill="var(--accent)" />
      <path d="M12 2.5 22 20.5H12z" fill="#fff" fillOpacity=".28" />
      <path d="M12 9v7m0 0-2.6-2.6M12 16l2.6-2.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function Titlebar({
  state,
  query,
  setQuery,
  searchRef,
}: {
  state: AppState;
  query: string;
  setQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const t = state.totals;
  return (
    <header className={`titlebar ${state.platform === "darwin" ? "mac" : ""}`}>
      <div className="brand">
        <Logo />
        <span>Prism</span>
      </div>
      <div className="titlebar-center">
        <label className="search">
          <Icon name="search" size={14} />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search downloads" spellCheck={false} />
          {query ? (
            <button className="clear" onClick={() => setQuery("")} aria-label="Clear search">
              <Icon name="x" size={12} />
            </button>
          ) : (
            <kbd>Ctrl+F</kbd>
          )}
        </label>
      </div>
      <div className={`speed-readout ${t.speed > 0 ? "live" : ""}`} title={`${t.active} downloading · ${t.queued} waiting`}>
        <Icon name="arrowDown" size={13} stroke={2} />
        <span className="num">{speed(t.speed)}</span>
      </div>
    </header>
  );
}
