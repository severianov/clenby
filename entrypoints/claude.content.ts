/**
 * THE content script — matches https://claude.ai/* only.
 * Boots the runtime: core services in order, then features from the registry.
 * All logic lives in src/; this file stays thin.
 */

import { defineContentScript } from "wxt/utils/define-content-script";
import { browser } from "wxt/browser";
import { CompanionRuntime } from "@/core/runtime";
import companionCss from "@/styles/companion.css?inline";

export default defineContentScript({
  matches: ["https://claude.ai/*"],
  runAt: "document_idle",

  async main(ctx) {
    // Companion base styles first (theme feature adds cc-structural/cc-theme).
    if (!document.getElementById("cc-companion")) {
      const style = document.createElement("style");
      style.id = "cc-companion";
      style.textContent = companionCss;
      document.head.appendChild(style);
    }

    try {
      const runtime = new CompanionRuntime();
      await runtime.boot();

      // Orphan watchdog. After an extension reload/update this script keeps
      // running in already-open tabs, but every runtime API in it is dead —
      // without this, feature polls error-spam the extensions card until the
      // tab is refreshed. WXT's ctx.onInvalidated can't catch this case on
      // its own (no new script injects into an old tab), so poll runtime.id.
      const watchdog = window.setInterval(() => {
        let alive = true;
        try {
          alive = Boolean(browser.runtime?.id);
        } catch {
          alive = false;
        }
        if (!alive) {
          window.clearInterval(watchdog);
          runtime.shutdown();
        }
      }, 5000);
      ctx.onInvalidated(() => {
        window.clearInterval(watchdog);
        runtime.shutdown();
      });
    } catch (err) {
      // A boot failure must never surface as an uncaught error on the
      // chrome://extensions card — contain it here. Individual feature mount
      // failures are already contained inside the runtime.
      console.error("[cc] runtime boot failed (contained)", err);
    }
  },
});
