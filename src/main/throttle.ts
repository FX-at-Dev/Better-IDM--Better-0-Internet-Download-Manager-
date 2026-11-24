/** Token bucket. `rate` is bytes per second; 0 means unlimited. */
export class TokenBucket {
  private tokens = 0;
  private last = Date.now();
  constructor(public rate = 0) {
    this.tokens = rate;
  }

  setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;
    this.tokens = Math.min(this.tokens, rate);
  }

  /** Wait until `n` bytes may pass. */
  async take(n: number, signal?: AbortSignal): Promise<void> {
    while (this.rate > 0) {
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= n || this.tokens >= this.rate) {
        this.tokens -= n;
        return;
      }
      const wait = Math.max(10, Math.min(250, ((n - this.tokens) / this.rate) * 1000));
      await sleep(wait, signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Rolling bytes-per-second meter with a one-sample-per-second history. */
export class SpeedMeter {
  private window: { t: number; n: number }[] = [];
  private acc = 0;
  total = 0;
  history: number[] = [];

  add(n: number): void {
    this.acc += n;
    this.total += n;
  }

  /** Call regularly; folds accumulated bytes into the window. */
  tick(now = Date.now()): void {
    if (this.acc) this.window.push({ t: now, n: this.acc });
    this.acc = 0;
    const cutoff = now - 3000;
    while (this.window.length && this.window[0].t < cutoff) this.window.shift();
  }

  get speed(): number {
    if (!this.window.length) return 0;
    const sum = this.window.reduce((a, b) => a + b.n, 0);
    return sum / 3;
  }

  sample(max = 90): void {
    this.history.push(Math.round(this.speed));
    if (this.history.length > max) this.history.shift();
  }

  reset(): void {
    this.window = [];
    this.acc = 0;
  }
}
