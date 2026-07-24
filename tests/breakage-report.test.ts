/**
 * Unit tests for the breakage-report pipeline — `shared/claude-build.ts` (the
 * join key read off claude.ai's `<html>`) and the pure parts of
 * `features/selector-health/report.ts`.
 *
 * Invariants under test:
 * 1. Build identity degrades to nulls, never to junk, when claude.ai stops
 *    shipping an attribute — nothing in the extension may depend on it.
 * 2. Every claude.ai-sourced value is charset-clamped before it reaches
 *    markdown: no newline may break a table row, no backtick may escape a
 *    code span, no field may grow unbounded.
 * 3. The report never contains message text — only anchor names, counters and
 *    structural paths.
 * 4. The prefilled issue URL stays inside the length budget, and says so when
 *    it had to trim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { UNKNOWN_BUILD, formatClaudeBuild, readClaudeBuild } from "../src/shared/claude-build.ts";
import {
  buildOverrideShare,
  buildReport,
  detectAgent,
  issueUrl,
  reportTitle,
  type ReportAnchor,
  type ReportInput,
} from "../src/features/selector-health/report.ts";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");

/** Minimal stand-in for the one thing readClaudeBuild touches. */
function docWith(attrs: Record<string, string>): Document {
  const dataset: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) dataset[k] = v;
  return { documentElement: { dataset } } as unknown as Document;
}

const BUILD = {
  buildId: "abf2f5bc42",
  gitHash: "abf2f5bc42b1a60999610329e905dfe5ac2135c2",
  appVersion: "1.0.0",
  colorVersion: "v2",
  builtAt: "2026-07-24T00:00:00.000Z",
};

function anchor(over: Partial<ReportAnchor> = {}): ReportAnchor {
  return {
    ns: "selectors",
    name: "conversationColumn",
    kind: "selector",
    state: "broken",
    lastMatchedVariant: null,
    lastMatchedAt: null,
    matchCount: 0,
    missStreak: 12,
    lastMatchPath: "main > div > div",
    deps: ["outline", "themes"],
    overridden: false,
    ...over,
  };
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    extVersion: "0.1.1",
    build: BUILD,
    anchors: [anchor()],
    now: NOW,
    agent: { browser: "Chrome 140", platform: "Linux" },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. build identity
// ---------------------------------------------------------------------------

test("readClaudeBuild reads the attributes claude.ai actually ships", () => {
  const b = readClaudeBuild(
    docWith({
      buildId: "abf2f5bc42",
      gitHash: "abf2f5bc42b1a60999610329e905dfe5ac2135c2",
      version: "1.0.0",
      colorVersion: "v2",
      buildTimestamp: "1784912245",
    }),
  );
  assert.equal(b.buildId, "abf2f5bc42");
  assert.equal(b.gitHash, "abf2f5bc42b1a60999610329e905dfe5ac2135c2");
  assert.equal(b.appVersion, "1.0.0");
  assert.equal(b.colorVersion, "v2");
  // data-build-timestamp is epoch SECONDS, not ms.
  assert.equal(b.builtAt, new Date(1784912245 * 1000).toISOString());
});

test("missing attributes degrade to null, never to junk", () => {
  const b = readClaudeBuild(docWith({}));
  assert.deepEqual(b, UNKNOWN_BUILD);
  assert.equal(formatClaudeBuild(b), "unknown");
});

test("build fields are charset-clamped and length-capped", () => {
  const b = readClaudeBuild(
    docWith({
      buildId: 'evil" onload=x `cmd` |pipe',
      version: "x".repeat(200),
      buildTimestamp: "not-a-number",
    }),
  );
  // Everything outside [A-Za-z0-9._-] is dropped: quotes, spaces, '=',
  // backticks and pipes all go, leaving inert text.
  assert.equal(b.buildId, "evilonloadxcmdpipe");
  assert.ok(!/[`|"'\s=<>]/.test(b.buildId ?? ""));
  assert.equal(b.appVersion?.length, 64);
  assert.equal(b.builtAt, null);
});

test("formatClaudeBuild skips absent fields instead of printing holes", () => {
  const s = formatClaudeBuild({ ...UNKNOWN_BUILD, buildId: "abc123" });
  assert.equal(s, "abc123");
});

// ---------------------------------------------------------------------------
// 2 + 3. report content and clamping
// ---------------------------------------------------------------------------

test("report carries environment, the build id and the broken anchor", () => {
  const md = buildReport(input());
  assert.match(md, /\| Clenby \| 0\.1\.1 \|/);
  assert.match(md, /\| Browser \| Chrome 140 \|/);
  assert.match(md, /abf2f5bc42/);
  assert.match(md, /1 broken · 0 on a shipped fallback/);
  assert.match(md, /`conversationColumn` \(selector\)/);
  assert.match(md, /breaks: outline, themes/);
  assert.match(md, /last seen at: `main > div > div`/);
});

test("a hostile anchor path cannot break the markdown or grow unbounded", () => {
  const md = buildReport(
    input({
      anchors: [
        anchor({
          lastMatchPath: `a\nb|c\`d${"x".repeat(500)}`,
          lastMatchedVariant: "fall|back\n1",
        }),
      ],
    }),
  );
  const pathLine = md.split("\n").find((l) => l.includes("last seen at")) ?? "";
  assert.ok(!pathLine.includes("|"), "pipe must not survive into a report line");
  assert.ok(!pathLine.includes("`d"), "backtick must not escape the code span");
  assert.ok(pathLine.length < 220, `path line unbounded: ${pathLine.length}`);
  assert.match(md, /…/, "an over-long path is visibly truncated");
});

test("healthy-everything still produces a usable report", () => {
  const md = buildReport(input({ anchors: [anchor({ state: "healthy", missStreak: 0 })] }));
  assert.match(md, /Every anchor is healthy/);
  assert.match(md, /0 broken · 0 on a shipped fallback · 1 healthy/);
});

test("report states its own privacy boundary", () => {
  const md = buildReport(input());
  assert.match(md, /no message text/i);
});

test("title groups duplicates by build id", () => {
  assert.equal(
    reportTitle(input()),
    "1 anchor broke on claude.ai abf2f5bc42 — conversationColumn",
  );
  const many = input({
    anchors: [anchor({ name: "a" }), anchor({ name: "b" }), anchor({ name: "c" })],
  });
  assert.match(reportTitle(many), /^3 anchors broke on claude\.ai abf2f5bc42 — a, b \+1$/);
});

// ---------------------------------------------------------------------------
// 4. issue URL
// ---------------------------------------------------------------------------

test("issue URL prefills title and body", () => {
  const i = input();
  const url = new URL(issueUrl(i, buildReport(i)));
  assert.equal(url.origin + url.pathname, "https://github.com/severianov/clenby/issues/new");
  assert.equal(url.searchParams.get("title"), reportTitle(i));
  assert.match(url.searchParams.get("body") ?? "", /conversationColumn/);
});

test("an over-long report is trimmed and says so", () => {
  const many = Array.from({ length: 400 }, (_, n) => anchor({ name: `anchor${n}` }));
  const i = input({ anchors: many });
  const url = issueUrl(i, buildReport(i));
  assert.ok(url.length < 8000, `URL too long for a browser: ${url.length}`);
  const body = new URL(url).searchParams.get("body") ?? "";
  assert.match(body, /trimmed to fit a URL/);
  assert.match(body, /Copy report/);
});

// ---------------------------------------------------------------------------
// override sharing
// ---------------------------------------------------------------------------

test("shared override is importable JSON plus the build it was written for", () => {
  const md = buildOverrideShare(
    "conversationColumn",
    "selectors",
    { primary: "main .max-w-4xl", source: "repair", basedOn: "0.1.1", at: "2026-07-25" },
    { extVersion: "0.1.1", build: BUILD },
  );
  assert.match(md, /### Override for `conversationColumn`/);
  assert.match(md, /abf2f5bc42/);
  const json = md.slice(md.indexOf("```json") + 7, md.lastIndexOf("```")).trim();
  const parsed = JSON.parse(json) as {
    selectors: { version: number; entries: Record<string, { primary: string }> };
  };
  assert.equal(parsed.selectors.version, 1);
  assert.equal(parsed.selectors.entries["conversationColumn"]?.primary, "main .max-w-4xl");
});

// ---------------------------------------------------------------------------
// agent detection
// ---------------------------------------------------------------------------

test("detectAgent prefers userAgentData brands over UA sniffing", () => {
  const nav = {
    userAgentData: { platform: "macOS", brands: [{ brand: "Google Chrome", version: "140" }] },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/9",
  } as unknown as Navigator;
  assert.deepEqual(detectAgent(nav), { browser: "Google Chrome 140", platform: "macOS" });
});

test("detectAgent falls back to the UA string, and Edge is not Chrome", () => {
  const edge = {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  } as unknown as Navigator;
  assert.deepEqual(detectAgent(edge), { browser: "Edge 140", platform: "Windows" });

  const ff = {
    userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
  } as unknown as Navigator;
  assert.deepEqual(detectAgent(ff), { browser: "Firefox 128", platform: "Android" });
});

test("an unrecognisable agent reports 'unknown' rather than throwing", () => {
  const nav = { userAgent: "" } as unknown as Navigator;
  assert.deepEqual(detectAgent(nav), { browser: "unknown", platform: "unknown" });
});
