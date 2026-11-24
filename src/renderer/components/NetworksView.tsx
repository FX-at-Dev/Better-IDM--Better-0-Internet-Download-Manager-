import { useState } from "react";
import type { AppState } from "../../shared/types";
import { bytes, splitSpeed } from "../lib/format";
import { AreaChart } from "./Charts";
import { Icon } from "./Icon";
import { Btn, NumberInput, Toggle } from "./ui";

const api = window.prism;

export function NetworksView({ state }: { state: AppState }) {
  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [err, setErr] = useState("");
  const nets = state.networks;
  const enabled = nets.filter((n) => n.enabled && n.present);
  const [num, unit] = splitSpeed(state.totals.speed);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Networks</h1>
          <div className="sub">Every enabled connection downloads its share of each file at the same time.</div>
        </div>
      </div>

      <section className="card net-hero">
        <div className="net-hero-stats">
          <div className="muted small">Combined speed</div>
          <div className="mega num">
            {num}
            <span>{unit}</span>
          </div>
          <div className="legend">
            {nets.map((n) => (
              <span key={n.id} className={n.enabled && n.present ? "" : "off"}>
                <i style={{ background: n.color }} /> {n.name}
              </span>
            ))}
          </div>
        </div>
        <div className="net-hero-chart">
          <AreaChart series={nets.filter((n) => n.enabled).map((n) => ({ values: n.history, color: n.color }))} height={150} />
        </div>
      </section>

      {enabled.length < 2 && (
        <div className="callout">
          <Icon name="info" size={16} />
          <span>
            Connect a second network — Ethernet, a USB-tethered phone, or a second Wi-Fi adapter — and Prism will pull from both at once. Networks that share one router
            usually share one internet line, so the gain comes from genuinely separate connections.
          </span>
        </div>
      )}

      <div className="net-grid">
        {nets.map((n) => {
          const [s, u] = splitSpeed(n.speed);
          return (
            <div key={n.id} className={`card net-card ${n.enabled ? "" : "disabled"} ${n.present ? "" : "absent"}`} style={{ ["--net" as string]: n.color }}>
              <div className="net-top">
                <span className="net-glyph">
                  <Icon name={/wi-?fi|wlan|wireless/i.test(n.name) ? "wifi" : "network"} size={18} />
                </span>
                <div className="net-name">
                  <b>{n.name}</b>
                  <span className="mono muted small">{n.address || "system default"}</span>
                </div>
                <div className="grow" />
                <Toggle checked={n.enabled} onChange={(v) => api.updateNetwork(n.id, { enabled: v })} label={`Use ${n.name}`} />
              </div>
              <div className="net-speed num">
                {s}
                <span>{u}</span>
              </div>
              <AreaChart series={[{ values: n.history, color: n.color }]} height={70} grid={false} />
              <div className="net-controls">
                <label>
                  <span className="muted small">Connections</span>
                  <NumberInput value={n.connections} min={1} max={32} width={70} onCommit={(v) => api.updateNetwork(n.id, { connections: v })} />
                </label>
                <label>
                  <span className="muted small">Speed cap</span>
                  <NumberInput value={n.limitKBps} min={0} suffix="KB/s" width={120} onCommit={(v) => api.updateNetwork(n.id, { limitKBps: v })} />
                </label>
              </div>
              <div className="net-foot muted small">
                <span>{bytes(n.sessionBytes)} this session</span>
                {!n.present && <span className="warn-text">Disconnected</span>}
                {n.custom && (
                  <button className="link-btn" onClick={() => api.removeNetwork(n.id)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <form
          className="card net-card add-net"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr("");
            try {
              await api.addNetwork(name, addr.trim());
              setName("");
              setAddr("");
            } catch (x) {
              setErr(String((x as Error).message).replace(/^.*Error: /, ""));
            }
          }}
        >
          <div className="net-top">
            <span className="net-glyph">
              <Icon name="plus" size={18} />
            </span>
            <div className="net-name">
              <b>Add a network by IP</b>
              <span className="muted small">For adapters Prism didn't detect, or a VPN interface.</span>
            </div>
          </div>
          <input className="text" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="text mono" placeholder="Local IPv4, e.g. 192.168.42.17" value={addr} onChange={(e) => setAddr(e.target.value)} />
          {err && <div className="err">{err}</div>}
          <Btn type="submit" icon="plus" disabled={!addr.trim()}>
            Add network
          </Btn>
        </form>
      </div>
    </div>
  );
}
