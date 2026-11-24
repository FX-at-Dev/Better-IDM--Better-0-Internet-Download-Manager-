import os from "node:os";
import http from "node:http";
import https from "node:https";
import { SpeedMeter, TokenBucket } from "./throttle.js";
import type { NetworkConfig, NetworkView, Settings } from "../shared/types.js";

const PALETTE = ["#4f8cff", "#2fb67c", "#e0a32e", "#a776f0", "#e5679a", "#35b5c9", "#8fbf3f", "#e07b4f"];

/** A usable outgoing interface: requests bound to `address` leave through it. */
export class Network {
  meter = new SpeedMeter();
  bucket = new TokenBucket(0);
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  present = true;

  constructor(
    public cfg: NetworkConfig,
    public color: string,
  ) {
    // A socket bound to an IPv4 address can only reach IPv4 servers, so resolve hosts to IPv4 too.
    const opts = { keepAlive: true, maxSockets: 64, localAddress: cfg.address || undefined, family: cfg.address ? 4 : undefined } as const;
    this.httpAgent = new http.Agent(opts);
    this.httpsAgent = new https.Agent(opts);
    this.bucket.setRate(cfg.limitKBps * 1024);
  }

  get id(): string {
    return this.cfg.id;
  }

  connections(defaultCount: number): number {
    return this.cfg.connections > 0 ? this.cfg.connections : defaultCount;
  }

  view(defaultCount: number): NetworkView {
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      address: this.cfg.address,
      enabled: this.cfg.enabled,
      present: this.present,
      custom: this.cfg.custom,
      connections: this.connections(defaultCount),
      limitKBps: this.cfg.limitKBps,
      speed: this.meter.speed,
      sessionBytes: this.meter.total,
      history: this.meter.history.slice(-60),
      color: this.color,
    };
  }

  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

interface Detected {
  name: string;
  address: string;
}

/** Non-internal IPv4 interfaces, skipping link-local and common virtual adapters. */
export function detectInterfaces(): Detected[] {
  const out: Detected[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|Hyper-V|Loopback|WSL|docker|vbox|tailscale|ZeroTier|br-|veth/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

export function idFor(name: string): string {
  return "net-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Keeps the live set of networks in sync with the OS and the saved config.
 * Saved entries keep their enabled/limit settings across restarts; addresses
 * follow DHCP changes because detected networks are matched by interface name.
 */
export class NetworkManager {
  nets = new Map<string, Network>();
  constructor(private getSettings: () => Settings, private saveNetworks: (n: NetworkConfig[]) => void) {}

  refresh(): void {
    const s = this.getSettings();
    const saved = new Map(s.networks.map((n) => [n.id, n]));
    const detected = detectInterfaces();
    const configs: NetworkConfig[] = [];
    const seen = new Set<string>();

    for (const d of detected) {
      let id = idFor(d.name);
      if (seen.has(id)) id += "-" + d.address.replace(/\./g, "-");
      seen.add(id);
      const prev = saved.get(id);
      configs.push({
        id,
        name: prev?.name || d.name,
        address: d.address,
        enabled: prev ? prev.enabled : true,
        custom: false,
        connections: prev?.connections ?? 0,
        limitKBps: prev?.limitKBps ?? 0,
      });
    }
    // keep custom networks and absent detected ones (so their settings survive a replug)
    for (const n of s.networks) {
      if (seen.has(n.id)) continue;
      configs.push({ ...n });
    }
    if (!configs.length) {
      configs.push({ id: "net-default", name: "Default route", address: "", enabled: true, custom: false, connections: 0, limitKBps: 0 });
    }

    const present = new Set(detected.map((d) => d.address));
    const next = new Map<string, Network>();
    configs.forEach((cfg, i) => {
      const old = this.nets.get(cfg.id);
      let net: Network;
      if (old && old.cfg.address === cfg.address) {
        old.cfg = cfg;
        old.bucket.setRate(cfg.limitKBps * 1024);
        net = old;
      } else {
        old?.destroy();
        net = new Network(cfg, PALETTE[i % PALETTE.length]);
        if (old) {
          net.meter = old.meter;
          net.color = old.color;
        }
      }
      net.present = cfg.custom || !cfg.address || present.has(cfg.address);
      next.set(cfg.id, net);
    });
    for (const [id, old] of this.nets) if (!next.has(id)) old.destroy();
    this.nets = next;

    const changed = JSON.stringify(configs) !== JSON.stringify(s.networks);
    if (changed) this.saveNetworks(configs);
  }

  /** Networks a download may use right now. */
  usable(): Network[] {
    return [...this.nets.values()].filter((n) => n.cfg.enabled && n.present);
  }

  get(id: string): Network | undefined {
    return this.nets.get(id);
  }

  views(defaultCount: number): NetworkView[] {
    return [...this.nets.values()].map((n) => n.view(defaultCount));
  }

  tick(): void {
    for (const n of this.nets.values()) n.meter.tick();
  }

  sample(): void {
    for (const n of this.nets.values()) n.meter.sample();
  }
}
