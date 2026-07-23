/**
 * claude.ai's OWN stock palette, both modes — the compiler's base layer for
 * the Light/Dark mode setting.
 *
 * Why this exists: the mode setting forces one half of a preset's token set,
 * but presets only override the HANDFUL of vars they care about. Forcing
 * "light" while claude.ai renders dark used to flip just those few vars and
 * leave every other surface dark — the "half-themed page" bug. The compiler
 * now emits THIS full palette (for the chosen mode) underneath every themed
 * preset, so the page starts from a complete, coherent claude.ai light/dark
 * baseline and the preset's own tokens layer on top. When the chosen mode
 * matches what claude.ai renders, every value is identical to the site's own
 * and the layer is a visual no-op.
 *
 * Values were read off the live site (getComputedStyle on html, extension
 * styles disabled), claude.ai build d8ab11f, color version v2, 2026-07-22.
 * When claude.ai reships its palette, re-capture the same way — this file is
 * data only.
 */

/** The var names the base layer covers — claude.ai core tokens. */
export interface ClaudePalette {
  /** --bg-000 … --bg-500. */
  bg: readonly [string, string, string, string, string, string];
  /** --text-000 … --text-500. */
  text: readonly [string, string, string, string, string, string];
  /** --border-100 … --border-400 (one value — the site fans it out too;
   *  claude applies these with per-use alpha modifiers). */
  border: string;
  /** --danger-000 … --danger-200. */
  danger: readonly [string, string, string];
  /** --accent-pro-000 … --accent-pro-200. */
  accentPro: readonly [string, string, string];
  /** --oncolor-100 … --oncolor-300. */
  oncolor: readonly [string, string, string];
  /**
   * The CDS token family (claude's newer design system — `bg-surface-1`,
   * `text-primary` classes on projects/settings surfaces). Defined at :root
   * keyed to the real mode; without this layer those surfaces keep the other
   * mode's literals (dark project cards on a light theme — found in the
   * 2026-07-23 surface audit). Values verbatim from the site, including the
   * modern `hsl(from …)` relative-color syntax. Deliberately EXCLUDES the
   * `--cds-fill-*` action tokens: claude re-declares those per `.cds-root`
   * with intentionally inverted values (a primary button is white-on-dark,
   * black-on-light — and per-region variants exist), so a uniform override
   * paints buttons unreadable. Fills stay claude's own; they pair safely
   * with either mode.
   */
  cds: Readonly<Record<string, string>>;
}

export const CLAUDE_PALETTE: Record<"light" | "dark", ClaudePalette> = {
  dark: {
    bg: ["60 2% 17%", "60 2% 12%", "60 2% 9%", "0 0% 7%", "0 0% 4%", "0 0% 4%"],
    text: ["60 14% 97%", "60 14% 97%", "55 9% 74%", "55 9% 74%", "48 5% 57%", "48 5% 57%"],
    border: "53 12% 87%",
    danger: ["0 77% 81%", "0 73% 59%", "0 73% 59%"],
    accentPro: ["246 75% 84%", "248 67% 67%", "248 67% 67%"],
    oncolor: ["0 0% 100%", "60 6.7% 97.1%", "60 6.7% 97.1%"],
    cds: {
      "--cds-surface-0": "#0d0d0d",
      "--cds-surface-1": "#1a1a19",
      "--cds-surface-2": "#2c2c2a",
      "--cds-surface-3": "#383835",
      "--cds-text-primary": "#fff",
      "--cds-text-secondary": "#c3c2b7",
      "--cds-text-disabled": "hsl(from #fff h s l / 35%)",
      "--cds-text-danger": "#ec7e7e",
      "--cds-text-warning": "#db9300",
      "--cds-text-success": "#0ca30c",
      "--cds-border-strong": "hsl(from #fff h s l / 20%)",
      "--cds-border-danger": "#641919",
      "--cds-bg-accent": "#032042",
      "--cds-bg-danger": "#3c0e0e",
    },
  },
  light: {
    bg: ["0 0% 100%", "60 14% 97%", "60 11% 95%", "45 12% 93%", "50 11% 89%", "50 11% 89%"],
    text: ["0 0% 7%", "0 0% 7%", "60 3% 21%", "60 3% 21%", "43 3% 47%", "43 3% 47%"],
    border: "60 2% 12%",
    danger: ["0 58% 35%", "0 61% 52%", "0 61% 52%"],
    accentPro: ["249 48% 44%", "248 67% 63%", "248 67% 63%"],
    oncolor: ["0 0% 100%", "60 6.7% 97.1%", "60 6.7% 97.1%"],
    cds: {
      "--cds-surface-0": "#f9f9f7",
      "--cds-surface-1": "#fcfcfb",
      "--cds-surface-2": "#fff",
      "--cds-surface-3": "#fff",
      "--cds-text-primary": "#0b0b0b",
      "--cds-text-secondary": "#52514e",
      "--cds-text-disabled": "hsl(from #0b0b0b h s l / 35%)",
      "--cds-text-danger": "#8e2626",
      "--cds-text-warning": "#734500",
      "--cds-text-success": "#006300",
      "--cds-border-strong": "hsl(from #0b0b0b h s l / 20%)",
      "--cds-border-danger": "#f09595",
      "--cds-bg-accent": "#cde2fb",
      "--cds-bg-danger": "#fad6d6",
    },
  },
};

/** The base layer's declarations (no selector), `!important` like every other
 *  claude var override (specificity lesson 1). Includes `color-scheme` so
 *  scrollbars/form controls follow the forced mode, not claude's data-mode. */
export function basePaletteDecls(mode: "light" | "dark"): string[] {
  const p = CLAUDE_PALETTE[mode];
  const out: string[] = [`color-scheme:${mode}!important;`];
  p.bg.forEach((v, i) => out.push(`--bg-${i}00:${v}!important;`));
  p.text.forEach((v, i) => out.push(`--text-${i}00:${v}!important;`));
  for (const lvl of [100, 200, 300, 400]) out.push(`--border-${lvl}:${p.border}!important;`);
  p.danger.forEach((v, i) => out.push(`--danger-${i}00:${v}!important;`));
  p.accentPro.forEach((v, i) => out.push(`--accent-pro-${i}00:${v}!important;`));
  p.oncolor.forEach((v, i) => out.push(`--oncolor-${(i + 1) * 100}:${v}!important;`));
  return out;
}

/** The CDS family's declarations, separate from {@link basePaletteDecls}
 *  because they need a DIFFERENT scope: claude (re)declares these tokens on
 *  every `.cds-root` element (html itself is one, but nested roots re-declare
 *  and would beat an html-level override), so the compiler must emit them
 *  against the roots too — see compileTheme. */
export function cdsDecls(mode: "light" | "dark"): string[] {
  return Object.entries(CLAUDE_PALETTE[mode].cds).map(([name, value]) => `${name}:${value}!important;`);
}
