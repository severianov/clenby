/**
 * Diagnostic report for a claude.ai breakage — the bridge between "a feature
 * stopped attaching" and a fix.
 *
 * The health ledger already knows exactly what broke; the only missing step
 * was getting it off the user's machine in a shape a maintainer can act on.
 * This module renders that ledger as markdown and prefills a GitHub issue.
 *
 * NOT telemetry, and the distinction is load-bearing (the project ships no
 * servers and no background reporting): nothing here sends anything. The user
 * presses a button, the text goes to their clipboard or into a GitHub issue
 * form they can read and edit, and they submit it themselves.
 *
 * PRIVACY: the report carries anchor names, health states, counters and
 * structural ancestor paths — never message text, titles, ids or URLs. The
 * ancestor paths come from `shared/repair-sketch`, which already strips to
 * stable structural hooks under the same policy as the repair DOM sketch.
 * Every claude.ai-sourced value is length-clamped before it lands in the
 * markdown, so a hostile attribute cannot break out of the report.
 */

import type { AnchorState } from "@/core/overrides";
import { formatClaudeBuild, type ClaudeBuild } from "@/shared/claude-build";

/** New-issue endpoint for the public repo. */
const ISSUE_URL = "https://github.com/severianov/clenby/issues/new";

/**
 * GitHub prefill rides the query string, and long URLs get truncated by
 * browsers and proxies well before the server complains. Keep the encoded
 * body under this and point at the clipboard copy for the rest.
 */
const MAX_ENCODED_BODY = 6000;

/** Ancestor paths are the one free-form field — clamp them hard. */
const MAX_PATH = 160;

export interface ReportAnchor {
  ns: "selectors" | "endpoints";
  name: string;
  kind: "selector" | "endpoint";
  state: AnchorState;
  lastMatchedVariant: string | null;
  /** Epoch ms. */
  lastMatchedAt: number | null;
  matchCount: number;
  missStreak: number;
  lastMatchPath: string | null;
  deps: readonly string[];
  overridden: boolean;
}

export interface ReportInput {
  /** `browser.runtime.getManifest().version`. */
  extVersion: string;
  build: ClaudeBuild;
  anchors: readonly ReportAnchor[];
  /** Injectable for tests. */
  now?: number;
  /** Injectable for tests; defaults to the live navigator. */
  agent?: AgentInfo;
}

export interface AgentInfo {
  browser: string;
  platform: string;
}

/** Minimal shape of the Chromium-only `navigator.userAgentData`. */
interface UaDataLike {
  platform?: string;
  brands?: ReadonlyArray<{ brand: string; version: string }>;
}

/**
 * Best-effort browser + platform. `userAgentData` is Chromium-only and its
 * brand list carries deliberate decoys ("Not)A;Brand"), so the real engine is
 * whichever brand we recognize; everything else falls back to UA sniffing,
 * which is fine for a bug report and never used for behavior.
 */
export function detectAgent(nav: Navigator = navigator): AgentInfo {
  const uaData = (nav as Navigator & { userAgentData?: UaDataLike }).userAgentData;
  const ua = nav.userAgent || "";

  let browserName = "unknown";
  const known = ["Firefox", "Microsoft Edge", "Google Chrome", "Chromium", "Opera", "Safari"];
  const brand = uaData?.brands?.find((b) => known.includes(b.brand));
  if (brand) {
    browserName = `${brand.brand} ${brand.version}`;
  } else {
    // Order matters: Edge and Opera both also claim "Chrome".
    const m =
      /(Firefox)\/(\d+)/.exec(ua) ??
      /(Edg)\/(\d+)/.exec(ua) ??
      /(OPR)\/(\d+)/.exec(ua) ??
      /(Chrome)\/(\d+)/.exec(ua) ??
      /(Safari)\/\d+/.exec(ua);
    if (m) {
      const label = m[1] === "Edg" ? "Edge" : m[1] === "OPR" ? "Opera" : m[1];
      browserName = `${label} ${m[2] ?? ""}`.trim();
    }
  }

  const platform = uaData?.platform || guessPlatform(ua);
  return { browser: clampField(browserName), platform: clampField(platform) };
}

function guessPlatform(ua: string): string {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "unknown";
}

/** Control chars (incl. the newlines that would break a markdown table row)
 *  plus the two characters that can escape a table cell or a code span. */
// eslint-disable-next-line no-control-regex
const TABLE_BREAKERS = /[\u0000-\u001F\u007F|`]/g;

/** Strip control chars and markdown-table breakers, then clamp. */
function clampField(raw: string, max = 64): string {
  const v = raw.replace(TABLE_BREAKERS, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return v.length > 0 ? v : "unknown";
}

function clampPath(raw: string): string {
  const v = raw.replace(TABLE_BREAKERS, " ").replace(/\s+/g, " ").trim();
  return v.length > MAX_PATH ? `${v.slice(0, MAX_PATH)}…` : v;
}

function ago(at: number | null, now: number): string {
  if (at === null) return "never this session";
  const delta = Math.max(0, now - at);
  if (delta < 60_000) return "seconds ago";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

/** One bullet per unhealthy anchor — the part a maintainer actually reads. */
function anchorLines(a: ReportAnchor, now: number): string[] {
  const out: string[] = [];
  const via = a.lastMatchedVariant ? ` via \`${clampField(a.lastMatchedVariant, 40)}\`` : "";
  out.push(
    `- \`${clampField(a.name, 48)}\` (${a.kind})${a.overridden ? " — locally overridden" : ""}` +
      ` — last matched ${ago(a.lastMatchedAt, now)}${via}` +
      `, ${a.matchCount} match${a.matchCount === 1 ? "" : "es"} this session` +
      `, ${a.missStreak} consecutive miss${a.missStreak === 1 ? "" : "es"}`,
  );
  if (a.deps.length > 0) out.push(`  - breaks: ${a.deps.join(", ")}`);
  if (a.lastMatchPath) out.push(`  - last seen at: \`${clampPath(a.lastMatchPath)}\``);
  return out;
}

/** Short, searchable, and duplicate-obvious: the build id does the grouping. */
export function reportTitle(input: ReportInput): string {
  const broken = input.anchors.filter((a) => a.state === "broken");
  const build = input.build.buildId ? ` on claude.ai ${input.build.buildId}` : "";
  if (broken.length === 0) return `Selector health report${build}`;
  const names = broken
    .slice(0, 2)
    .map((a) => a.name)
    .join(", ");
  const more = broken.length > 2 ? ` +${broken.length - 2}` : "";
  return `${broken.length} anchor${broken.length === 1 ? "" : "s"} broke${build} — ${names}${more}`;
}

/** The full markdown report — identical text for the clipboard and the issue. */
export function buildReport(input: ReportInput): string {
  const now = input.now ?? Date.now();
  const agent = input.agent ?? detectAgent();
  const { build } = input;

  const by = (s: AnchorState): ReportAnchor[] => input.anchors.filter((a) => a.state === s);
  const broken = by("broken");
  const fallback = by("fallback");
  const healthy = by("healthy").length + by("override").length;
  const unknown = by("unknown").length;

  const out: string[] = [];

  out.push("### Environment", "");
  out.push("| | |", "|---|---|");
  out.push(`| Clenby | ${clampField(input.extVersion, 24)} |`);
  out.push(`| Browser | ${agent.browser} |`);
  out.push(`| Platform | ${agent.platform} |`);
  out.push(`| claude.ai build | ${formatClaudeBuild(build)} |`);
  if (build.gitHash) out.push(`| claude.ai commit | \`${build.gitHash}\` |`);
  out.push(`| Captured | ${new Date(now).toISOString()} |`);
  out.push("");

  out.push(
    "### Anchor health",
    "",
    `${broken.length} broken · ${fallback.length} on a shipped fallback · ` +
      `${healthy} healthy · ${unknown} not queried this session`,
    "",
  );

  if (broken.length > 0) {
    out.push("**Broken**", "");
    for (const a of broken) out.push(...anchorLines(a, now));
    out.push("");
  }
  if (fallback.length > 0) {
    out.push("**On a shipped fallback** (primary died, still working)", "");
    for (const a of fallback) out.push(...anchorLines(a, now));
    out.push("");
  }
  if (broken.length === 0 && fallback.length === 0) {
    out.push("Every anchor is healthy — nothing degraded at capture time.", "");
  }

  out.push("### What happened", "", "<!-- What were you doing? Anything else worth knowing? -->", "");
  out.push(
    "---",
    "",
    "<sub>Generated by the Clenby selector-health panel. Anchor names, health counters and " +
      "structural element paths only — no message text, conversation titles or URLs.</sub>",
  );

  return out.join("\n");
}

/**
 * A user's local repair, in a shape that can become the shipped default.
 *
 * This is the payoff of self-healing: whoever hits a break first fixes it on
 * their own machine, and that fix is already validated against the live page.
 * Without a way to hand it back it dies on one laptop; with one, the next
 * release ships it to everyone who hasn't hit the break yet.
 *
 * The override is emitted as the same JSON shape the editor's Import accepts,
 * so a maintainer (or another user, today, before any release) can paste it
 * straight back in.
 */
export function buildOverrideShare(
  name: string,
  ns: "selectors" | "endpoints",
  override: unknown,
  input: Pick<ReportInput, "extVersion" | "build">,
): string {
  const safeName = clampField(name, 48);
  const file = { [ns]: { version: 1, entries: { [safeName]: override } } };
  return [
    `### Override for \`${safeName}\``,
    "",
    `- claude.ai build: ${formatClaudeBuild(input.build)}`,
    `- Clenby: ${clampField(input.extVersion, 24)}`,
    "",
    "```json",
    JSON.stringify(file, null, 2),
    "```",
    "",
    "<sub>Validated against the live page on the machine it was written on. " +
      "Paste it into the selector-health panel's **Import…** to apply it locally, " +
      "or ship it as the new default.</sub>",
  ].join("\n");
}

/**
 * Prefilled new-issue URL. Long reports get trimmed with a pointer to the
 * clipboard copy rather than silently losing their tail — a truncated report
 * that looks complete is worse than one that says it isn't.
 */
export function issueUrl(input: ReportInput, body: string): string {
  let encoded = encodeURIComponent(body);
  let finalBody = body;
  if (encoded.length > MAX_ENCODED_BODY) {
    const note =
      "\n\n---\n\n**⚠ This report was trimmed to fit a URL.** " +
      'Use "Copy report" in the selector-health panel and paste the full version here.';
    const room = Math.floor(body.length * (MAX_ENCODED_BODY / encoded.length)) - note.length;
    // slice() can cut a surrogate pair in half, and encodeURIComponent
    // throws URIError on a lone surrogate — which would kill this button
    // precisely when the report is long enough to need trimming.
    const cut = body.slice(0, Math.max(0, room)).replace(/[\uD800-\uDBFF]$/, "");
    finalBody = cut + note;
    encoded = encodeURIComponent(finalBody);
  }
  const params = new URLSearchParams({
    title: reportTitle(input),
    body: finalBody,
    labels: "bug",
  });
  return `${ISSUE_URL}?${params.toString()}`;
}
