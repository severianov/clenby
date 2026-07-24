/**
 * claude.ai's own build identity, read off `<html>`.
 *
 * The page stamps `data-build-id`, `data-git-hash`, `data-build-timestamp`,
 * `data-version` and `data-color-version` on the document element. Nothing in
 * the extension depends on them functionally — they exist here purely as the
 * JOIN KEY for breakage: an anchor that dies is a mystery on its own, but
 * "every report on build abf2f5bc42 lost the same anchor" is a single fix.
 *
 * Deliberately NOT registered in core/selectors.ts: entries there are feature
 * anchors that carry health, fallbacks and repair. These attributes carry no
 * feature — when they vanish every field degrades to null, the report says
 * "unknown", and nothing else changes. Tracking them in the ledger would raise
 * a break alert for something that never broke anything.
 *
 * Values reach a GitHub issue URL, so every field is clamped to a conservative
 * charset and length on the way out — a hostile or malformed attribute cannot
 * smuggle markdown, newlines or unbounded text into a report.
 */

/** The longest any of these fields is allowed to be once sanitized. */
const MAX_FIELD = 64;

/** Build ids, git hashes and versions are all `[A-Za-z0-9._-]`. */
const UNSAFE = /[^A-Za-z0-9._-]/g;

export interface ClaudeBuild {
  /** Short build id, e.g. "abf2f5bc42". */
  buildId: string | null;
  /** Full commit sha of the claude.ai build. */
  gitHash: string | null;
  /** claude.ai's own app version, e.g. "1.0.0". */
  appVersion: string | null;
  /** Palette generation, e.g. "v2" — moves when claude.ai reworks its colors,
   *  which is exactly when theme presets need re-checking. */
  colorVersion: string | null;
  /** ISO 8601, derived from `data-build-timestamp` (epoch SECONDS). */
  builtAt: string | null;
}

export const UNKNOWN_BUILD: ClaudeBuild = {
  buildId: null,
  gitHash: null,
  appVersion: null,
  colorVersion: null,
  builtAt: null,
};

/** Clamp one raw attribute to the safe charset, or null if it's empty/absent. */
function clean(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(UNSAFE, "").slice(0, MAX_FIELD);
  return v.length > 0 ? v : null;
}

/** `data-build-timestamp` is epoch seconds; anything unparseable → null. */
function toIso(raw: string | null | undefined): string | null {
  const secs = Number(clean(raw));
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const d = new Date(secs * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Read the build identity from a document. Never throws and never returns
 * partial junk — an attribute claude.ai stops shipping simply reads null.
 */
export function readClaudeBuild(doc: Document = document): ClaudeBuild {
  const el = doc.documentElement as HTMLElement | null;
  if (!el) return UNKNOWN_BUILD;
  const ds = el.dataset;
  return {
    buildId: clean(ds["buildId"]),
    gitHash: clean(ds["gitHash"]),
    appVersion: clean(ds["version"]),
    colorVersion: clean(ds["colorVersion"]),
    builtAt: toIso(ds["buildTimestamp"]),
  };
}

/**
 * One-line human form for the status/report surfaces:
 * "abf2f5bc42 · app 1.0.0 · palette v2 · built 2026-07-24".
 * Returns "unknown" when the page stamped nothing we recognize.
 */
export function formatClaudeBuild(b: ClaudeBuild): string {
  const bits: string[] = [];
  if (b.buildId) bits.push(b.buildId);
  if (b.appVersion) bits.push(`app ${b.appVersion}`);
  if (b.colorVersion) bits.push(`palette ${b.colorVersion}`);
  if (b.builtAt) bits.push(`built ${b.builtAt.slice(0, 10)}`);
  return bits.length > 0 ? bits.join(" · ") : "unknown";
}
