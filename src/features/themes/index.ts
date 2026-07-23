/**
 * Themes — Tier 1, session scope. Mounts FIRST (registry order) so --cc-*
 * tokens exist before any companion UI renders.
 *
 * Drives src/theme/engine.ts through the managed context:
 * - applies the active preset + tweaks + themeMode from settings at mount.
 *   themeMode is a hard two-way choice (light/dark — no auto since
 *   2026-07-22; storage.getSettings resolves legacy "auto" to claude.ai's
 *   current appearance): themed presets render exactly that half over a full
 *   claude.ai base palette, the Off preset stays stock and follows the page,
 * - re-applies on settings changes (the gear-menu ↔ content channel is
 *   storage.onChanged),
 * - watches html[data-mode] (READ ONLY — React reverts writes), restamps the
 *   effective html[data-cc-mode] and re-emits `theme:applied` so mode-aware
 *   features can react (the effective mode only moves under Off — themed
 *   surfaces render the chosen mode regardless of claude.ai's appearance),
 * - resets to stock claude.ai on unmount (Off always restores stock).
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ThemeEngine } from "@/theme/engine";
import { presetById } from "@/theme/presets";
import type { ThemeModeSetting } from "@/theme/tokens";

export const themes: FeatureModule = {
  id: "themes",
  tier: 1,
  scope: "session",

  mount(ctx: FeatureContext) {
    const engine = new ThemeEngine();
    // Cached for the data-mode observer (settings reads are async; the
    // observer must resolve the effective mode synchronously).
    let themeMode: ThemeModeSetting = "dark";

    const apply = async (): Promise<void> => {
      const settings = await ctx.storage.getSettings();
      if (ctx.signal.aborted) return;
      themeMode = settings.themeMode;
      const applied = engine.apply(
        presetById(settings.activePresetId),
        settings.tweaks,
        themeMode,
      );
      ctx.bus.emit("theme:applied", applied);
    };

    // Initial apply.
    void apply();

    // Gear-menu / other-tab settings changes.
    ctx.onCleanup(ctx.storage.onSettingsChanged(() => void apply()));

    // Mode flips (claude.ai's own appearance setting). We only read
    // data-mode; the compiled CSS already carries both scopes, so this just
    // restamps the effective data-cc-mode and re-emits. Under a themed
    // preset the effective mode doesn't move — Clenby's surfaces stay on the
    // chosen mode by design; only Off follows the page.
    ctx.observe(
      document.documentElement,
      () => {
        const id = engine.appliedThemeId;
        if (id) ctx.bus.emit("theme:applied", { themeId: id, mode: engine.syncMode(themeMode) });
      },
      { attributes: true, attributeFilter: ["data-mode"] },
    );

    ctx.onCleanup(() => engine.reset());
  },
};
