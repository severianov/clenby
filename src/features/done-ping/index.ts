/**
 * Done-ping — Tier 1 rider, session scope. Tab-title ● while generating,
 * ✓ when a generation finishes in a background tab, reset on focus/visibility.
 *
 * Consumes the core generation detector's events — NEVER its own streaming
 * detection. This is the smallest feature — a good reference for new ones.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";

let baseTitle = "";

export const donePing: FeatureModule = {
  id: "done-ping",
  tier: 1,
  scope: "session",

  mount(ctx: FeatureContext) {
    baseTitle = document.title;

    // claude.ai renames the tab per conversation — track the base title while
    // idle so our markers never trap a stale name.
    ctx.setInterval(() => {
      const t = document.title;
      if (!t.startsWith("● ") && !t.startsWith("✓ ")) baseTitle = t;
    }, 1000);

    ctx.on("generation:start", () => {
      document.title = `● ${baseTitle}`;
    });
    ctx.on("generation:end", () => {
      document.title = document.hasFocus() ? baseTitle : `✓ ${baseTitle}`;
    });
    ctx.listen(window, "focus", () => {
      document.title = baseTitle;
    });
    ctx.listen(document, "visibilitychange", () => {
      if (!document.hidden) document.title = baseTitle;
    });

    ctx.onCleanup(() => {
      document.title = baseTitle;
    });
  },
};
