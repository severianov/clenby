/**
 * The theme token schema. A theme is PURE DATA — a JSON
 * token bundle. All CSS text is generated in `compile.ts`; presets contain
 * zero selectors and zero CSS.
 *
 * Schema notes relative to the blueprint:
 * - Every Surface/typography/layout field is optional: `default.json` ("Off")
 *   omits all claude overrides and the compiler emits nothing for absent
 *   tokens. The bg/text scales are fixed-length tuples with `null` holes so a
 *   preset can override only some levels (e.g. Focus sets only --bg-100).
 * - `Hsl` is an HSL triplet ("42 55% 96%", matching claude's var format) but
 *   raw CSS colors ("#1e1e1e", "rgba(...)") pass through unchanged — the Code
 *   preset was authored in hex (see cssColor() in compile.ts).
 */

/** "42 55% 96%" (HSL triplet, may carry "/ alpha") — or a raw CSS color. */
export type Hsl = string;

/**
 * The light/dark setting for Clenby's themed surfaces — a hard two-way
 * choice (the old "auto" option was removed 2026-07-22; legacy stored
 * "auto"/junk values are resolved to claude.ai's current appearance at read
 * time, see storage.getSettings):
 * - "light" / "dark" — the theme renders that half of its dual token set,
 *   regardless of what claude.ai's own appearance setting says. We can't
 *   write data-mode (React reverts it), so the mode is enforced at compile
 *   time: a full claude.ai base palette for the chosen mode underneath the
 *   preset's tokens, emitted under BOTH data-mode scopes (see compile.ts).
 * - The "default" (Off) preset ignores the setting: Off is stock claude.ai,
 *   and Clenby's own surfaces follow the page's actual data-mode.
 */
export type ThemeModeSetting = "light" | "dark";

export interface SurfaceTokens {
  /** --bg-000 … --bg-500 (null = don't override that level). */
  bg?: readonly [Hsl | null, Hsl | null, Hsl | null, Hsl | null, Hsl | null, Hsl | null];
  /** --text-000 … --text-400 (null = don't override that level). */
  text?: readonly [Hsl | null, Hsl | null, Hsl | null, Hsl | null, Hsl | null];
  /** --border-200/300/400 (single value fans out). */
  border?: Hsl;
  /** Paints body, .bg-bg-100 AND main.dframe-content together (a known landmine). */
  pageBg?: Hsl;
  /** Explicit background-color paints where var overrides aren't enough. */
  paint?: { bg000?: Hsl; bg200?: Hsl };
  sidebarBg?: Hsl;
  sidebarBorder?: Hsl;
  /** Explicit body-text color on answers (Book/Code/WhatsApp set it). */
  bodyText?: Hsl;
  /** Explicit text color inside the user bubble. */
  userText?: Hsl;
  userBubbleBg?: Hsl; // .bg-bg-300
  userBubbleBorder?: Hsl;
  /** Assistant bubble surface — consumed by the "bubbles" structural variant. */
  assistantBubbleBg?: Hsl;
  codeBlockBg?: Hsl; // pre > div
  codeBlockBorder?: Hsl;
  inlineCode?: { fg: Hsl; bg?: Hsl };
  link?: Hsl;
  heading?: Hsl;
  strong?: Hsl;
  /** Divider under each message block (Compact). */
  messageDivider?: Hsl;
  /** Reading-card surface — consumed by the "card" structural variant (Focus). */
  cardBg?: Hsl;
  cardBorder?: Hsl;
  /** Full box-shadow value for the card. */
  cardShadow?: string;
}

/** The ONLY styling companion surfaces may use (compiled to --cc-*). */
export interface CompanionTokens {
  bg: Hsl;
  surface: Hsl;
  surfaceRaised: Hsl;
  /** Second elevation step above surfaceRaised (hover-on-raised, code chips,
   *  chevron hover — the notes/theme-picker redesign's "raised-2"). */
  surfaceRaised2: Hsl;
  /**
   * The floating status-bar pill surface — a near-opaque ELEVATED surface that
   * must stay clearly visible against the page/composer in this mode (dark
   * themes: near-opaque dark, e.g. rgba(20,20,22,.93); light
   * themes: a light elevated surface). Never the same as the composer bg.
   */
  barBg: Hsl;
  text: Hsl;
  textMuted: Hsl;
  textFaint: Hsl;
  border: Hsl;
  /** Defaults to claude terracotta 15 63% 60%. */
  accent: Hsl;
  /** Secret-guard red. */
  danger: Hsl;
  /** Pin / highlight gold. */
  gold: Hsl;
  /** Success green (idle ● dot, copy-success flashes, done-todo checkbox).
   *  Reference: #7c9a67 ≈ hsl(95 20% 50%). */
  ok: Hsl;
  /** Full box-shadow value. */
  shadow: string;
}

/** Structural variant — the ONLY non-token axis (static CSS in structural.css
 *  keyed on html[data-cc-style]; variants read tokens for all colors/sizes). */
export type ThemeStyle = "default" | "bubbles" | "card" | "editor";

export interface ThemeTypography {
  /** A claude font var name ("--font-anthropic-serif") or a raw font stack. */
  bodyFontVar?:
    | "--font-anthropic-sans"
    | "--font-anthropic-serif"
    | "--font-anthropic-mono"
    | string;
  bodySizePx?: number;
  lineHeight?: number;
  userSizePx?: number;
  userLineHeight?: number;
  codeSizePx?: number;
  paragraphGapEm?: number;
  headingGapTopEm?: number;
  headingGapBottomEm?: number;
  headingLetterSpacingEm?: number;
}

export interface ThemeLayout {
  /** main .max-w-3xl override. */
  columnMaxRem?: number;
  /** [data-test-render-count] margin-bottom. */
  messageGapRem?: number;
  /** --msg-bubble-py (Compact), e.g. ".3rem". */
  bubblePaddingY?: string;
  /** Focus: 0.12 with hover restore. */
  sidebarRestOpacity?: number;
}

export interface ThemeModes {
  // BOTH required — dual-mode is an owner decision (lesson 10).
  light: { claude: SurfaceTokens; companion: CompanionTokens };
  dark: { claude: SurfaceTokens; companion: CompanionTokens };
}

export interface ThemeTokens {
  id: string;
  name: string;
  /** The preset's IDENTITY color — the picker swatch dot (Off #666, Classic #c2c0b6, Book #e8ddc4,
   *  Compact #7b8494, Focus #4a4a44, True Black #000, Code #007acc,
   *  WhatsApp #00a884). Curated data, NOT derived from surface tokens — it
   *  never varies with the active theme or mode. */
  swatch: string;
  /** Readable foreground ON the swatch tile (the picker card's "Aa" glyph).
   *  Curated identity data like `swatch` — never varies with theme or mode. */
  swatchFg: string;
  style: ThemeStyle;
  /** Pin the compiler's claude.ai base-palette layer to ONE mode regardless
   *  of the chosen themeMode. For presets whose two halves are deliberately
   *  identical (True Black), the pin stops the other mode's base palette
   *  from leaking through un-overridden vars (light danger/accent/border/
   *  color-scheme on a black page). Absent = base follows the chosen mode. */
  basePalette?: "light" | "dark";
  typography: ThemeTypography;
  layout: ThemeLayout;
  modes: ThemeModes;
}

/**
 * User fine-tuning (v1 spec) — stored separately in settings and merged over
 * the active preset. "Reset tweaks" deletes the partial.
 */
export interface ThemeTweaks {
  bodySizePx?: number;
  bodyFontVar?: string;
  lineHeight?: number;
  columnMaxRem?: number;
  density?: "comfortable" | "compact";
}

/** Merge user tweaks over a preset. Pure; the preset object is not mutated. */
export function merge(preset: ThemeTokens, tweaks: ThemeTweaks): ThemeTokens {
  const typography: ThemeTypography = { ...preset.typography };
  const layout: ThemeLayout = { ...preset.layout };

  if (tweaks.bodySizePx !== undefined) typography.bodySizePx = tweaks.bodySizePx;
  if (tweaks.bodyFontVar !== undefined) typography.bodyFontVar = tweaks.bodyFontVar;
  if (tweaks.lineHeight !== undefined) typography.lineHeight = tweaks.lineHeight;
  if (tweaks.columnMaxRem !== undefined) layout.columnMaxRem = tweaks.columnMaxRem;
  if (tweaks.density === "compact") {
    typography.paragraphGapEm = Math.min(typography.paragraphGapEm ?? 1, 0.6);
    layout.messageGapRem = Math.min(layout.messageGapRem ?? 1, 0.5);
    layout.bubblePaddingY = layout.bubblePaddingY ?? ".3rem";
  }

  return { ...preset, typography, layout };
}

/**
 * Runtime guard for preset JSON (imported bundles pass through here once at
 * module init — a malformed preset fails loudly at build/test time, not
 * silently on the page).
 */
export function assertThemeTokens(raw: unknown, sourceName: string): ThemeTokens {
  const fail = (msg: string): never => {
    throw new Error(`[cc] invalid theme preset ${sourceName}: ${msg}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const t = raw as Record<string, unknown>;
  if (typeof t["id"] !== "string" || !t["id"]) return fail("missing id");
  if (typeof t["name"] !== "string" || !t["name"]) return fail("missing name");
  if (typeof t["swatch"] !== "string" || !t["swatch"]) return fail("missing swatch");
  if (typeof t["swatchFg"] !== "string" || !t["swatchFg"]) return fail("missing swatchFg");
  if (!["default", "bubbles", "card", "editor"].includes(t["style"] as string)) {
    return fail(`bad style "${String(t["style"])}"`);
  }
  if (t["basePalette"] !== undefined && t["basePalette"] !== "light" && t["basePalette"] !== "dark") {
    return fail(`bad basePalette "${String(t["basePalette"])}"`);
  }
  // The bg/text tuples and `border` are emitted RAW into hsl(var(--…)/α)
  // consumers — a hex or malformed entry would pass silently and break every
  // claude surface, so they must be HSL triplets (optionally with "/ α").
  const isTriplet = (v: unknown): boolean =>
    typeof v === "string" &&
    /^\d+(\.\d+)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%(\s*\/\s*(0|0?\.\d+|1))?$/.test(v.trim());
  const modes = t["modes"] as Record<string, unknown> | undefined;
  if (!modes || typeof modes !== "object") return fail("missing modes");
  for (const mode of ["light", "dark"] as const) {
    const m = modes[mode] as Record<string, unknown> | undefined;
    if (!m || typeof m !== "object") return fail(`missing modes.${mode}`);
    if (!m["claude"] || typeof m["claude"] !== "object") return fail(`missing modes.${mode}.claude`);
    const claude = m["claude"] as Record<string, unknown>;
    for (const [key, len] of [["bg", 6], ["text", 5]] as const) {
      const tuple = claude[key];
      if (tuple === undefined) continue;
      if (!Array.isArray(tuple) || tuple.length !== len) {
        return fail(`modes.${mode}.claude.${key} must be a ${len}-tuple`);
      }
      for (const v of tuple) {
        if (v !== null && !isTriplet(v)) {
          return fail(`modes.${mode}.claude.${key} entry "${String(v)}" is not an HSL triplet`);
        }
      }
    }
    if (claude["border"] !== undefined && !isTriplet(claude["border"])) {
      return fail(`modes.${mode}.claude.border "${String(claude["border"])}" is not an HSL triplet`);
    }
    const companion = m["companion"] as Record<string, unknown> | undefined;
    if (!companion || typeof companion !== "object") return fail(`missing modes.${mode}.companion`);
    for (const key of [
      "bg",
      "surface",
      "surfaceRaised",
      "surfaceRaised2",
      "barBg",
      "text",
      "textMuted",
      "textFaint",
      "border",
      "accent",
      "danger",
      "gold",
      "ok",
      "shadow",
    ]) {
      if (typeof companion[key] !== "string") return fail(`modes.${mode}.companion.${key}`);
    }
  }
  return raw as ThemeTokens;
}
