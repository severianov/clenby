/**
 * Unit tests for the theme compiler's mode model (node --test, no DOM).
 *
 * The invariants under test are the ones that broke in the field:
 * 1. A themed preset compiled for mode M carries claude.ai's FULL stock
 *    palette for M under BOTH data-mode scopes — picking "light" must
 *    produce a complete light page even while claude.ai renders dark (the
 *    "half-themed page" bug: only the preset's own few vars used to flip).
 * 2. The preset's own tokens still WIN over that base layer (cascade order).
 * 3. Presets without a pageBg get the base page paint (body/main lesson 3).
 * 4. The Off preset compiles ZERO claude-side CSS (stock page) and its
 *    companion tokens follow the page: each half under its own scope.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { compileTheme } from "../src/theme/compile.ts";
import { CLAUDE_PALETTE } from "../src/theme/claude-palette.ts";
import { SELECTORS, selAll } from "../src/core/selectors.ts";
import type { CompanionTokens, ThemeTokens } from "../src/theme/tokens.ts";

const companion = (accent: string): CompanionTokens => ({
  bg: "0 0% 10%",
  surface: "0 0% 14%",
  surfaceRaised: "0 0% 18%",
  surfaceRaised2: "0 0% 22%",
  barBg: "0 0% 8% / 0.9",
  text: "0 0% 90%",
  textMuted: "0 0% 70%",
  textFaint: "0 0% 50%",
  border: "0 0% 100% / 0.14",
  accent,
  danger: "0 72% 62%",
  gold: "46 74% 66%",
  ok: "95 20% 50%",
  shadow: "0 10px 34px rgba(0,0,0,.5)",
});

/** A minimal themed preset that overrides ONE bg level and no pageBg. */
const themed: ThemeTokens = {
  id: "test-theme",
  name: "Test",
  swatch: "#123456",
  swatchFg: "#ffffff",
  style: "default",
  typography: {},
  layout: {},
  modes: {
    dark: {
      claude: { bg: ["1 2% 3%", null, null, null, null, null] },
      companion: companion("15 63% 60%"),
    },
    light: {
      claude: { bg: ["4 5% 6%", null, null, null, null, null] },
      companion: companion("15 63% 55%"),
    },
  },
};

/** The Off preset shape (id "default", empty claude halves). */
const off: ThemeTokens = {
  ...themed,
  id: "default",
  name: "Off",
  modes: {
    dark: { claude: {}, companion: companion("15 63% 60%") },
    light: { claude: {}, companion: companion("15 63% 55%") },
  },
};

const DARK_SCOPE = 'html[data-mode="dark"][data-theme]';
const LIGHT_SCOPE = 'html[data-mode="light"][data-theme]';

test("themed preset for 'light' carries the full light base palette under BOTH scopes", () => {
  const css = compileTheme(themed, "light");
  for (const scope of [DARK_SCOPE, LIGHT_SCOPE]) {
    const idx = css.indexOf(scope);
    assert.ok(idx >= 0, `missing scope ${scope}`);
  }
  // Every bg/text level of the LIGHT palette is present (spot the full range).
  const light = CLAUDE_PALETTE.light;
  light.bg.forEach((v, i) => assert.ok(css.includes(`--bg-${i}00:${v}!important;`), `bg-${i}00`));
  light.text.forEach((v, i) =>
    assert.ok(css.includes(`--text-${i}00:${v}!important;`), `text-${i}00`),
  );
  // Both scopes carry the SAME (light) palette — no dark bg-000 anywhere.
  assert.ok(!css.includes(`--bg-000:${CLAUDE_PALETTE.dark.bg[0]}!important;`));
  // Scrollbars/controls follow the chosen mode.
  assert.ok(css.includes("color-scheme:light!important;"));
});

test("preset tokens win over the base palette (same selector, later rule)", () => {
  const css = compileTheme(themed, "light");
  const scoped = css.split("\n").filter((l) => l.startsWith(LIGHT_SCOPE));
  assert.ok(scoped.length >= 2, "expected base + preset rules under the light scope");
  const baseIdx = scoped.findIndex((l) => l.includes(`--bg-000:${CLAUDE_PALETTE.light.bg[0]}`));
  const presetIdx = scoped.findIndex((l) => l.includes("--bg-000:4 5% 6%"));
  assert.ok(baseIdx >= 0 && presetIdx >= 0, "both layers present");
  assert.ok(presetIdx > baseIdx, "preset rule must come after the base rule");
});

test("presets without pageBg get the base page paint (body/main lesson)", () => {
  const css = compileTheme(themed, "dark");
  assert.ok(
    css.includes(`background-color:hsl(${CLAUDE_PALETTE.dark.bg[1]})!important;`),
    "body/.bg-bg-100/main painted with the base --bg-100",
  );
  assert.ok(css.includes(`--cc-page:hsl(${CLAUDE_PALETTE.dark.bg[1]});`), "--cc-page fallback");
});

test("literal text repaints: body, user and composer text get chosen-mode fallbacks", () => {
  // claude.ai's message/composer text colors are literals keyed to the real
  // data-mode — without these fallbacks a preset that never sets bodyText
  // renders near-white text on a forced-light page.
  const css = compileTheme(themed, "light");
  const ink = `hsl(${CLAUDE_PALETTE.light.text[1]})`;
  assert.ok(
    css.includes(`.font-claude-response :is(p,li,blockquote){color:${ink}!important;}`) ||
      css.includes(`color:${ink}!important;`),
    "response body text painted",
  );
  assert.equal(
    css.split(`.ProseMirror{color:${ink}!important;caret-color:${ink};}`).length,
    3,
    "composer repainted under both scopes",
  );
});

test("code surfaces follow the SCOPE (real mode); the theme owns everything else", () => {
  // Syntax ink is a real-mode literal we cannot restyle — each scope's code
  // surface must come from that scope's half/palette so ink stays readable.
  // The selector is DERIVED, not retyped: this test used to hardcode
  // `.font-claude-response pre > div`, so when claude.ai inverted the shape to
  // `div.overflow-x-auto > pre.code-block__code` the rule stopped matching
  // anything on the real page while the test stayed green. Deriving it means a
  // future selector change can never pass here unnoticed.
  const css = compileTheme(themed, "light");
  const code = selAll("codeBlockSurface");
  const darkScopeCode = `html[data-mode="dark"] ${code}{background:hsl(${CLAUDE_PALETTE.dark.bg[2]})!important;}`;
  const lightScopeCode = `html[data-mode="light"] ${code}{background:hsl(${CLAUDE_PALETTE.light.bg[2]})!important;}`;
  assert.ok(css.includes(darkScopeCode), "dark scope keeps a dark code surface");
  assert.ok(css.includes(lightScopeCode), "light scope keeps a light code surface");
});

test("the code surface emits every candidate, so a DOM change degrades not disappears", () => {
  // An unpainted code block is the worst failure mode this theme has: the ink
  // is claude's own and real-mode bound, so losing the surface puts near-white
  // code on a light page. CSS cannot try candidates in order the way a runtime
  // query does, so the compiler emits them as one :is() union.
  const entry = SELECTORS.codeBlockSurface;
  const code = selAll("codeBlockSurface");
  assert.ok(code.startsWith(":is("), "code surface must compile to a :is() union");
  assert.ok(code.includes(entry.primary), "the verified primary is present");
  for (const fb of entry.fallbacks ?? []) {
    assert.ok(code.includes(fb), `fallback "${fb}" is present in the emitted rule`);
  }
  // The scope prefix must stay outside the union — a bare comma list would
  // leak the later arms out of html[data-mode="…"] and theme the whole page.
  const css = compileTheme(themed, "light");
  assert.ok(
    !css.includes(`html[data-mode="light"] ${entry.primary}, `),
    "candidates must not be emitted as an unscoped comma list",
  );
});

test("full sidebar takeover: chosen-mode surface + label repaint under BOTH scopes", () => {
  // The owner's call (2026-07-22): a light theme must not leave claude's
  // dark rail standing. Sidebar bg falls back to the chosen base --bg-100
  // and the mode-literal labels are repainted, under both data-mode scopes.
  const css = compileTheme(themed, "light");
  const bg = `aside.dframe-sidebar{background:hsl(${CLAUDE_PALETTE.light.bg[1]})!important;}`;
  const label = `aside.dframe-sidebar :is(a,button,span,p,div){color:hsl(${CLAUDE_PALETTE.light.text[2]});}`;
  for (const scope of ['html[data-mode="dark"]', 'html[data-mode="light"]']) {
    assert.ok(css.includes(`${scope} ${bg}`), `sidebar bg under ${scope}`);
    assert.ok(css.includes(`${scope} ${label}`), `sidebar labels under ${scope}`);
  }
});

test("mode picks which half of the preset renders — under both scopes", () => {
  const dark = compileTheme(themed, "dark");
  assert.ok(dark.includes("--bg-000:1 2% 3%!important;"), "dark half chosen");
  assert.ok(!dark.includes("--bg-000:4 5% 6%!important;"), "light half absent");
  // The chosen half's companion accent appears under BOTH mode scopes.
  const light = compileTheme(themed, "light");
  const lightAccent = "--cc-accent:hsl(15 63% 55%);";
  assert.ok(light.includes(`html[data-mode="dark"]{`) || light.includes(`html[data-mode="dark"] {`) || light.split(lightAccent).length === 3,
    "companion tokens emitted twice (once per scope)");
  assert.equal(light.split(lightAccent).length, 3, "light companion accent under both scopes");
});

test("Off compiles zero claude-side CSS and scope-matched companion halves", () => {
  const css = compileTheme(off, "dark");
  assert.ok(!css.includes("[data-theme]"), "no claude var scopes for Off");
  assert.ok(!css.includes("--bg-000"), "no claude palette for Off");
  assert.ok(!css.includes("color-scheme"), "no color-scheme override for Off");
  // Each half under its own scope — Clenby follows the page under Off.
  assert.ok(css.includes('html[data-mode="dark"]{--cc-bg:hsl(0 0% 10%);'));
  assert.equal(css.split("--cc-accent:hsl(15 63% 60%);").length, 2, "dark half once");
  assert.equal(css.split("--cc-accent:hsl(15 63% 55%);").length, 2, "light half once");
});
