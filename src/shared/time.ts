/**
 * Relative-time + countdown formatting. Pure functions, `now` is injectable so
 * they're deterministic in tests.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now" / "5m ago" / "3h ago" / "Jul 20" — compact relative past time. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const delta = now - t;
  if (delta < MIN) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Jul 20 · 10:42 PM" — the meta-line timestamp format. */
export function messageStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}

/** Countdown to a reset instant, e.g. "resets in 2h 14m" / "resets in 45m". */
export function countdown(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const delta = t - now;
  if (delta <= 0) return "resets now";
  const h = Math.floor(delta / HOUR);
  const m = Math.floor((delta % HOUR) / MIN);
  if (h >= 24) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

/** Human duration between two ISO timestamps (chat first→last), e.g. "1h 12m". */
export function durationBetween(startIso: string, endIso: string): string {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return "";
  const delta = b - a;
  const d = Math.floor(delta / DAY);
  const h = Math.floor((delta % DAY) / HOUR);
  const m = Math.floor((delta % HOUR) / MIN);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
