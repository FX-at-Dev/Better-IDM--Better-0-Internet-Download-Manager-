// Torrent downloads via WebTorrent (pure JS + optional native helpers).
// WebTorrent is an ES module, so it is loaded lazily with a real dynamic import.

export interface TorrentHandle {
  infoHash: string;
  name: string;
  length: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  progress: number;
  numPeers: number;
  ratio: number;
  done: boolean;
  files: { length: number }[];
  path: string;
  magnetURI: string;
  torrentFile?: Uint8Array;
  on(ev: string, cb: (...a: any[]) => void): void;
  once(ev: string, cb: (...a: any[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
}

let clientPromise: Promise<any> | null = null;
let loadError: string | null = null;

export function torrentAvailable(): boolean {
  return loadError === null;
}

async function client(): Promise<any> {
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const mod: any = await import("webtorrent");
        const WebTorrent = mod.default ?? mod;
        const c = new WebTorrent({ maxConns: 80 });
        c.on("error", (e: Error) => console.error("[torrent]", e.message));
        return c;
      } catch (e) {
        loadError = (e as Error).message;
        clientPromise = null;
        throw new Error("Torrent engine failed to load: " + loadError);
      }
    })();
  }
  return clientPromise;
}

/** Add a magnet link, .torrent URL or .torrent buffer. Resolves once metadata is known. */
export async function addTorrent(
  id: string | Uint8Array,
  dir: string,
  onMetadata: (t: TorrentHandle) => void,
): Promise<TorrentHandle> {
  const c = await client();
  return new Promise((resolve, reject) => {
    let t: TorrentHandle;
    try {
      t = c.add(id, { path: dir, destroyStoreOnDestroy: false }) as TorrentHandle;
    } catch (e) {
      return reject(e);
    }
    const onErr = (e: Error) => reject(e);
    t.once("error", onErr);
    t.once("metadata", () => onMetadata(t));
    t.once("ready", () => resolve(t));
    // resolve early so the UI can show peers/progress while metadata arrives
    setTimeout(() => resolve(t), 50);
  });
}

export async function shutdownTorrents(): Promise<void> {
  if (!clientPromise) return;
  const c = await clientPromise.catch(() => null);
  if (!c) return;
  await new Promise<void>((r) => c.destroy(() => r()));
}
