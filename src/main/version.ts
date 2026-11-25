/** "v1.2.3" / "1.2.3-beta.1" → [1, 2, 3]; anything unreadable → null. */
export function parseVersion(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `candidate` is a later release than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The version a GitHub ".../releases/tag/v1.2.3" address points to. */
export function versionFromTagUrl(url: string): string | null {
  const m = /\/releases\/tag\/v?([^/?#]+)$/.exec(url);
  return m && parseVersion(m[1]) ? m[1] : null;
}
