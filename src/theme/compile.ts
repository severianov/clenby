/**
 * Tokens → CSS text — the ONLY place theme CSS strings are built
 *. All claude-side selectors come from core/selectors.ts.
 *
 * Baked-in landmines (compiler concerns — no preset ever thinks about them):
 * 1. Claude var overrides are emitted scoped `html[data-mode="…"][data-theme]`
 *    with `!important` on every declaration (specificity lesson 1).
 * 2. Typography selectors always include descendants
 *    `.font-claude-response :is(p,li,blockquote)` (lesson 2).
 * 3. `pageBg` always paints `body, .bg-bg-100, main.dframe-content` together —
 *    dframe-content paints over body.
 * 4. Sidebar dim uses `!important` on opacity (lesson 4).
 * 5. The light-theme header-fade band is fixed via `--cc-page` + the static
 *    rule in structural.css (html.cc-themed gates it).
 *
 * Companion tokens are emitted per-mode as `--cc-*` on `html[data-mode=…]`
 * (html IS :root) — companion surfaces read only these names. Structural
 * variant surfaces (card, bubbles, editor) are emitted as `--ccs-*` custom
 * props consumed by the static rules in structural.css.
 *
 * The mode (the two-way themeMode setting, 2026-07-22): we cannot write
 * html[data-mode] (React reverts it), so the chosen mode is enforced inside
 * the compiled bundle — BOTH data-mode scopes receive (1) claude.ai's FULL
 * stock palette for the chosen mode (claude-palette.ts — without it a preset
 * only flips the few vars it overrides and the rest of the page stays in the
 * other mode, the "half-themed page" bug), then (2) the preset's own claude
 * tokens for that mode, then (3) the chosen half's companion tokens. When
 * the chosen mode matches what claude.ai renders, layer (1) is value-
 * identical to the site's own palette. The "default" (Off) preset skips all
 * claude-side CSS (Off = stock page) and its companion tokens follow the
 * page's actual mode — each half under its own scope.
 */

import { sel, selAll } from "@/core/selectors";
import { CLAUDE_PALETTE, basePaletteDecls, cdsDecls } from "./claude-palette";
import type { CompanionTokens, SurfaceTokens, ThemeTokens } from "./tokens";

/** Wrap an HSL triplet in hsl(); pass raw CSS colors (#…, rgb(…)) through. */
export function cssColor(v: string): string {
  const t = v.trim();
  if (t.startsWith("#") || t.includes("(")) return t;
  return `hsl(${t})`;
}

/** Wrap a claude font var name in var(); pass raw font stacks through. */
function cssFont(v: string): string {
  return v.startsWith("--") ? `var(${v})` : v;
}

type Mode = "light" | "dark";

const RESPONSE = sel("assistantMessage"); // .font-claude-response
const USER_MSG = sel("userMessage");
const COMPOSER = sel("composerInput");
const CHAT_TITLE = sel("chatTitle");
const USER_BUBBLE = sel("userBubble"); // .bg-bg-300
// The code surface is the one anchor a theme cannot afford to lose silently:
// when it stops matching, the block goes UNPAINTED and claude's real-mode ink
// (see the carve-out in compileTheme) lands on the themed page — near-white
// code on a light page. Emit every candidate so a DOM change degrades instead
// of disappearing.
const CODE_BLOCK = selAll("codeBlockSurface");
const INLINE_CODE = sel("inlineCode");
const COLUMN = sel("conversationColumn");
const MAIN = sel("mainContent");
const SIDEBAR = sel("sidebar");
const MSG_BLOCK = sel("messageBlock");

function modeScope(mode: Mode): string {
  return `html[data-mode="${mode}"]`;
}
function varScope(mode: Mode): string {
  // Lesson 1: bg vars live in a higher-specificity scope than text vars.
  return `html[data-mode="${mode}"][data-theme]`;
}

class CssBuilder {
  #out: string[] = [];

  rule(selector: string, decls: ReadonlyArray<string | false | null | undefined>): void {
    const body = decls.filter((d): d is string => typeof d === "string" && d.length > 0).join("");
    if (body) this.#out.push(`${selector}{${body}}`);
  }

  raw(text: string): void {
    this.#out.push(text);
  }

  toString(): string {
    return this.#out.join("\n");
  }
}

const MODES = ["dark", "light"] as const;

export function compileTheme(tokens: ThemeTokens, mode: Mode): string {
  const css = new CssBuilder();
  css.raw(`/* cc-theme: ${tokens.id} · ${mode} (generated — do not edit) */`);

  compileTypography(tokens, css);
  compileLayout(tokens, css);

  // The Off preset ("default" — literal here, NOT imported from presets/,
  // which would drag the JSON bundles into node test runs): zero claude-side
  // COLOR CSS (Off = stock page), companion tokens follow the page's actual
  // mode. Typography/layout tweaks above still emit under Off by design —
  // the gear's text-size stepper works without forcing a theme.
  if (tokens.id === "default") {
    for (const scope of MODES) compileCompanion(tokens.modes[scope].companion, scope, css);
    return css.toString();
  }

  const src = tokens.modes[mode];
  // basePalette pin: an identical-halves preset can keep its one true base
  // under either chosen mode — see the field's doc in tokens.ts. No shipped
  // preset sets it now (True Black gained a distinct True White light half).
  const baseMode = tokens.basePalette ?? mode;
  const base = CLAUDE_PALETTE[baseMode];

  // The bubbles/editor structural variants own the user-bubble box (radius,
  // borders) via static rules in structural.css reading --ccs-* props; only
  // default/card themes get the direct bubble rule.
  const directBubble = tokens.style === "default" || tokens.style === "card";

  for (const scope of MODES) {
    // Both data-mode scopes carry the chosen-mode bundle, so the chosen look
    // wins whatever claude.ai stamps (we never write data-mode) — with ONE
    // deliberate exception, verified on the live site 2026-07-22:
    //
    // THE THEME OWNS THE WHOLE FRAME; ONLY CODE BLOCKS FOLLOW THE PAGE.
    // claude.ai's var-driven surfaces flip with the base palette, but some
    // colors are LITERALS keyed to the real data-mode: message/composer/
    // header-title text and the sidebar's labels (all repainted below with
    // chosen-mode values — the owner explicitly wants full takeover, sidebar
    // included), and the syntax-highlighting ink — which we canNOT restyle.
    // So code-block surfaces alone are sourced from the SCOPE's half (dark
    // ink on the dark scope's surface, light on light — always readable).
    // When the chosen mode matches what claude.ai renders — the common case
    // — every value below is exactly the preset's own.
    const scopeHalf = tokens.modes[scope].claude;
    const scopePal = CLAUDE_PALETTE[scope];
    const surface: SurfaceTokens = {
      // Chosen-mode fallbacks: presets that never set these still need
      // body/main/header-fade painted (lesson 3 — main.dframe-content paints
      // OVER body), the literal message text repainted, and the sidebar
      // claimed; the base palette's own values make every one a no-op when
      // modes match.
      pageBg: base.bg[1],
      bodyText: base.text[1],
      userText: base.text[1],
      sidebarBg: base.bg[1],
      inlineCode: { fg: base.text[1], bg: base.bg[3] },
      ...src.claude,
      // Code ink: REAL-mode bound (see above) — deliberately overrides the
      // chosen half even when the preset set them.
      codeBlockBg: scopeHalf.codeBlockBg ?? scopePal.bg[2],
      codeBlockBorder: scopeHalf.codeBlockBorder,
    };
    // Base palette first — the preset's own var rule follows under the
    // identical selector, so the preset wins on cascade order.
    css.rule(varScope(scope), basePaletteDecls(baseMode));
    // CDS token family (projects/settings surfaces): claude re-declares
    // these on every `.cds-root`, nested ones included, so the override must
    // target the roots themselves — an html-level rule loses inside them.
    css.rule(
      `${varScope(scope)}, html[data-mode="${scope}"] .cds-root`,
      cdsDecls(baseMode),
    );
    compileSurface(surface, scope, css);
    if (directBubble) compileUserBubble(surface, scope, css);
    // Composer text and the header's conversation title are real-mode
    // literals on claude's side — repaint them for the chosen mode so they
    // stay visible on the forced page bg.
    css.rule(`${modeScope(scope)} ${COMPOSER}`, [
      `color:${cssColor(base.text[1])}!important;`,
      `caret-color:${cssColor(base.text[1])};`,
    ]);
    css.rule(
      `${modeScope(scope)} ${CHAT_TITLE}, ${modeScope(scope)} ${CHAT_TITLE} :is(button,span)`,
      [`color:${cssColor(base.text[1])}!important;`],
    );
    // Sidebar labels/icons are real-mode literals too — full-takeover
    // repaint for the chosen mode (generalizes the True Black chrome fixes
    // in structural.css: a broad tone for everything, !important only where
    // claude's own text-utility classes fight back).
    css.rule(`${modeScope(scope)} ${SIDEBAR} :is(a,button,span,p,div)`, [
      `color:${cssColor(base.text[2])};`,
    ]);
    css.rule(`${modeScope(scope)} ${SIDEBAR} [class*="text-text"]`, [
      `color:${cssColor(base.text[2])}!important;`,
    ]);
    compileCompanion(src.companion, scope, css);
  }
  return css.toString();
}

// ---------------------------------------------------------------------------

function compileTypography(tokens: ThemeTokens, css: CssBuilder): void {
  const t = tokens.typography;

  // Lesson 2: claude.ai sets per-paragraph type — descendants required.
  css.rule(`${RESPONSE}, ${RESPONSE} :is(p,li,blockquote)`, [
    t.bodyFontVar && `font-family:${cssFont(t.bodyFontVar)}!important;`,
    t.bodySizePx !== undefined && `font-size:${t.bodySizePx}px!important;`,
    t.lineHeight !== undefined && `line-height:${t.lineHeight}!important;`,
  ]);
  css.rule(`${RESPONSE} :is(p,ul,ol,blockquote)`, [
    t.paragraphGapEm !== undefined && `margin-bottom:${t.paragraphGapEm}em!important;`,
  ]);
  css.rule(`${RESPONSE} :is(h1,h2,h3)`, [
    t.headingGapTopEm !== undefined && `margin-top:${t.headingGapTopEm}em!important;`,
    t.headingGapBottomEm !== undefined && `margin-bottom:${t.headingGapBottomEm}em!important;`,
    t.headingLetterSpacingEm !== undefined && `letter-spacing:${t.headingLetterSpacingEm}em;`,
  ]);
  css.rule(USER_MSG, [
    t.bodyFontVar && `font-family:${cssFont(t.bodyFontVar)}!important;`,
    t.userSizePx !== undefined && `font-size:${t.userSizePx}px!important;`,
    t.userLineHeight !== undefined && `line-height:${t.userLineHeight}!important;`,
  ]);
  css.rule("pre code", [
    t.codeSizePx !== undefined && `font-size:${t.codeSizePx}px!important;line-height:1.45!important;`,
  ]);
}

function compileLayout(tokens: ThemeTokens, css: CssBuilder): void {
  const l = tokens.layout;
  css.rule(COLUMN, [
    l.columnMaxRem !== undefined && `max-width:${l.columnMaxRem}rem!important;`,
  ]);
  css.rule(MSG_BLOCK, [
    l.messageGapRem !== undefined && `margin-bottom:${l.messageGapRem}rem!important;`,
  ]);
  css.rule(USER_BUBBLE, [l.bubblePaddingY && `--msg-bubble-py:${l.bubblePaddingY};`]);
  if (l.sidebarRestOpacity !== undefined) {
    // Lesson 4: !important on opacity.
    css.rule(SIDEBAR, [
      `opacity:${l.sidebarRestOpacity}!important;transition:opacity .3s;`,
    ]);
    css.rule(`${SIDEBAR}:hover`, ["opacity:1!important;"]);
  }
}

function compileSurface(s: SurfaceTokens, mode: Mode, css: CssBuilder): void {
  const m = modeScope(mode);
  const v = varScope(mode);

  // ---- CSS variable overrides (lesson 1: scope + !important) ----
  const vars: string[] = [];
  s.bg?.forEach((val, i) => {
    if (val !== null && val !== undefined) vars.push(`--bg-${i}00:${val}!important;`);
  });
  s.text?.forEach((val, i) => {
    if (val !== null && val !== undefined) vars.push(`--text-${i}00:${val}!important;`);
  });
  if (s.border) {
    for (const lvl of [200, 300, 400]) vars.push(`--border-${lvl}:${s.border}!important;`);
  }
  // Header-fade fix input (structural.css reads --cc-page).
  if (s.pageBg) vars.push(`--cc-page:${cssColor(s.pageBg)};`);
  // Structural-variant surfaces (static rules in structural.css read these).
  if (s.assistantBubbleBg) vars.push(`--ccs-assistant-bubble:${cssColor(s.assistantBubbleBg)};`);
  if (s.userBubbleBg) vars.push(`--ccs-user-bubble-bg:${cssColor(s.userBubbleBg)};`);
  if (s.userBubbleBorder) vars.push(`--ccs-user-bubble-border:${cssColor(s.userBubbleBorder)};`);
  if (s.cardBg) vars.push(`--ccs-card-bg:${cssColor(s.cardBg)};`);
  if (s.cardBorder) vars.push(`--ccs-card-border:${cssColor(s.cardBorder)};`);
  if (s.cardShadow) vars.push(`--ccs-card-shadow:${s.cardShadow};`);
  css.rule(v, vars);

  // ---- page background (lesson 3: paint all three together) ----
  if (s.pageBg) {
    css.rule(`${m} body, ${m} .bg-bg-100, ${m} ${MAIN}`, [
      `background-color:${cssColor(s.pageBg)}!important;`,
    ]);
  }
  if (s.paint?.bg000) {
    css.rule(`${m} .bg-bg-000`, [`background-color:${cssColor(s.paint.bg000)}!important;`]);
  }
  if (s.paint?.bg200) {
    css.rule(`${m} .bg-bg-200`, [`background-color:${cssColor(s.paint.bg200)}!important;`]);
  }

  // ---- sidebar ----
  if (s.sidebarBg || s.sidebarBorder) {
    css.rule(`${m} ${SIDEBAR}`, [
      s.sidebarBg && `background:${cssColor(s.sidebarBg)}!important;`,
      s.sidebarBorder && `border-right:1px solid ${cssColor(s.sidebarBorder)};`,
    ]);
  }

  // ---- text colors ----
  if (s.bodyText) {
    css.rule(`${m} ${RESPONSE}, ${m} ${RESPONSE} :is(p,li,blockquote)`, [
      `color:${cssColor(s.bodyText)}!important;`,
    ]);
  }
  if (s.userText) {
    css.rule(`${m} ${USER_MSG}`, [`color:${cssColor(s.userText)}!important;`]);
  }
  if (s.heading) {
    css.rule(`${m} ${RESPONSE} :is(h1,h2,h3,h4)`, [
      `color:${cssColor(s.heading)}!important;`,
      // Editor-style themes keep headings in the body font.
      "font-family:inherit!important;",
    ]);
  }
  if (s.strong) css.rule(`${m} ${RESPONSE} strong`, [`color:${cssColor(s.strong)}!important;`]);
  if (s.link) css.rule(`${m} ${RESPONSE} a`, [`color:${cssColor(s.link)}!important;`]);

  // ---- code surfaces ----
  if (s.codeBlockBg || s.codeBlockBorder) {
    css.rule(`${m} ${CODE_BLOCK}`, [
      s.codeBlockBg && `background:${cssColor(s.codeBlockBg)}!important;`,
      s.codeBlockBorder && `border:1px solid ${cssColor(s.codeBlockBorder)}!important;`,
    ]);
  }
  if (s.inlineCode) {
    css.rule(`${m} ${INLINE_CODE}`, [
      `color:${cssColor(s.inlineCode.fg)}!important;`,
      s.inlineCode.bg && `background:${cssColor(s.inlineCode.bg)}!important;`,
    ]);
  }

  // ---- message divider (Compact) ----
  if (s.messageDivider) {
    css.rule(`${m} ${MSG_BLOCK}`, [
      `padding-bottom:.4rem;border-bottom:1px solid ${cssColor(s.messageDivider)};`,
    ]);
  }
}

/** Default-variant user bubble rule — kept separate so compileSurface stays
 *  readable and the variant skip logic is explicit. */
function compileUserBubble(s: SurfaceTokens, mode: Mode, css: CssBuilder): void {
  if (!s.userBubbleBg && !s.userBubbleBorder) return;
  css.rule(`${modeScope(mode)} ${USER_BUBBLE}`, [
    s.userBubbleBg && `background:${cssColor(s.userBubbleBg)}!important;`,
    s.userBubbleBorder && `border:1px solid ${cssColor(s.userBubbleBorder)}!important;`,
  ]);
}

function compileCompanion(c: CompanionTokens, mode: Mode, css: CssBuilder): void {
  // html IS :root — companion tokens ride the mode scope so #cc-root, the
  // status bar, panels AND any html-level consumer resolve identical names.
  css.rule(modeScope(mode), [
    `--cc-bg:${cssColor(c.bg)};`,
    `--cc-surface:${cssColor(c.surface)};`,
    `--cc-surface-raised:${cssColor(c.surfaceRaised)};`,
    `--cc-surface-raised-2:${cssColor(c.surfaceRaised2)};`,
    `--cc-bar-bg:${cssColor(c.barBg)};`,
    `--cc-text:${cssColor(c.text)};`,
    `--cc-text-muted:${cssColor(c.textMuted)};`,
    `--cc-text-faint:${cssColor(c.textFaint)};`,
    `--cc-border:${cssColor(c.border)};`,
    `--cc-accent:${cssColor(c.accent)};`,
    `--cc-danger:${cssColor(c.danger)};`,
    `--cc-gold:${cssColor(c.gold)};`,
    `--cc-ok:${cssColor(c.ok)};`,
    `--cc-shadow:${c.shadow};`,
  ]);
}
