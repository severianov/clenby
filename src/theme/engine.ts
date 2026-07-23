/**
 * The theme engine: applies a compiled token bundle by
 * writing ONE <style id="cc-theme"> and stamping html attributes. Switching
 * themes = replace textContent + attributes. Nothing else.
 *
 * Mode handling: we READ html[data-mode] and react to changes (the runtime
 * feature registers the attribute observer via its ctx). We NEVER write
 * data-mode ourselves — React reverts it. The two-way themeMode setting
 * (light/dark — no auto since 2026-07-22) picks which half of a themed
 * preset renders: enforcement happens inside the compiled bundle (compile.ts
 * feeds both data-mode scopes the chosen half over a full claude.ai base
 * palette). The "default" (Off) preset ignores the setting and follows the
 * page. The EFFECTIVE mode is stamped as html[data-cc-mode] — our own
 * attribute, safe to write — for the static mode-keyed rules in
 * companion.css.
 *
 * The engine itself owns no timers/observers — the `themes` feature drives it
 * through the managed FeatureContext, so all watching auto-disposes.
 */

import { compileTheme } from "./compile";
import { merge, type ThemeModeSetting, type ThemeTokens, type ThemeTweaks } from "./tokens";
import structuralCss from "./structural.css?inline";

export const THEME_STYLE_ID = "cc-theme";
export const STRUCTURAL_STYLE_ID = "cc-structural";

export type ThemeMode = "light" | "dark";

export interface AppliedTheme {
  themeId: string;
  mode: ThemeMode;
}

export function readMode(): ThemeMode {
  return document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
}

export class ThemeEngine {
  #appliedId: string | null = null;

  /**
   * Apply a preset merged with user tweaks. Idempotent; call again on any
   * settings change. `themeMode` picks which half of the preset's dual token
   * set renders (compile-time — see compile.ts); the Off preset ignores it
   * and follows claude.ai. Returns what was applied (for the theme:applied
   * event) with the EFFECTIVE mode Clenby's surfaces render in.
   */
  apply(preset: ThemeTokens, tweaks: ThemeTweaks, themeMode: ThemeModeSetting): AppliedTheme {
    const merged = merge(preset, tweaks);

    this.#ensureStructural();

    const style = this.#ensureStyle(THEME_STYLE_ID);
    style.textContent = compileTheme(merged, themeMode);

    const html = document.documentElement;
    html.setAttribute("data-cc-theme", merged.id);
    html.setAttribute("data-cc-style", merged.style);
    // "Off" keeps stock claude.ai chrome (incl. its own header fade).
    html.classList.toggle("cc-themed", merged.id !== "default");

    this.#appliedId = merged.id;
    return { themeId: merged.id, mode: this.syncMode(themeMode) };
  }

  /**
   * Re-resolve the effective mode — the chosen mode for themed presets, the
   * page's actual data-mode for Off — and stamp it as html[data-cc-mode],
   * the hook for static mode-keyed companion.css rules. Called on apply and
   * on every data-mode flip (which only moves the result under Off).
   */
  syncMode(themeMode: ThemeModeSetting): ThemeMode {
    const effective =
      this.#appliedId === null || this.#appliedId === "default" ? readMode() : themeMode;
    document.documentElement.setAttribute("data-cc-mode", effective);
    return effective;
  }

  /** Remove every trace — theme Off must always restore stock. */
  reset(): void {
    document.getElementById(THEME_STYLE_ID)?.remove();
    document.getElementById(STRUCTURAL_STYLE_ID)?.remove();
    const html = document.documentElement;
    html.removeAttribute("data-cc-theme");
    html.removeAttribute("data-cc-style");
    html.removeAttribute("data-cc-mode");
    html.classList.remove("cc-themed");
    this.#appliedId = null;
  }

  get appliedThemeId(): string | null {
    return this.#appliedId;
  }

  #ensureStructural(): void {
    if (!document.getElementById(STRUCTURAL_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STRUCTURAL_STYLE_ID;
      style.textContent = structuralCss;
      document.head.appendChild(style);
    }
  }

  /** The theme style always sits AFTER claude's styles and after structural. */
  #ensureStyle(id: string): HTMLStyleElement {
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    } else if (style !== document.head.lastElementChild) {
      document.head.appendChild(style); // keep cascade order deterministic
    }
    return style;
  }
}
