/**
 * Enter-behavior switch — Composer. Session scope.
 *
 * A SETTING (settings.enterToNewline, storage.sync, DEFAULT OFF). While OFF
 * this feature is a pure no-op — claude.ai's native Enter-to-send is
 * untouched. While ON, inside the composer:
 * - plain Enter        → inserts a newline (the site's send is stopped)
 * - Ctrl/Cmd+Enter     → sends, by clicking claude's REAL send button (the
 *                        exact undo-send fire technique — never an endpoint
 *                        of our own, so every native side effect is intact)
 * - Shift/Alt+Enter    → untouched (native newline behavior)
 *
 * COORDINATION WITH UNDO-SEND (bus-free, ordering-based): both features
 * listen for keydown on `document` in the CAPTURE phase. Same-target capture
 * listeners fire in REGISTRATION order, and this feature is registered
 * earlier (registry order: Tier 2 mounts before Tier 3 undo-send), so
 * on plain Enter it runs first and calls stopImmediatePropagation() —
 * undo-send never mistakes the newline keystroke for a send. The Mod+Enter
 * send goes through the send BUTTON click, which undo-send's click
 * interceptor sees normally — so an armed undo delay still applies to
 * Mod+Enter sends, exactly as it should.
 *
 * Newline insertion goes through ctx.composer.insertText (the ONE sanctioned
 * ProseMirror writer). If the insert fails the keystroke was still consumed —
 * a lost newline, never an accidental send (fail-safe direction; the
 * fail-open rule is about never BLOCKING sends the user asked for, which the
 * Mod+Enter path honors by simply doing nothing when no button is found).
 *
 * Teardown/OFF: the handler gates on `enabled` as its first check and the
 * capture listener is ctx-managed — disposed at unmount, so native behavior
 * is fully restored by default and after teardown.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";

const OWNER = "enter-behavior";

/** Send-button heuristic — same local aria-label lookup undo-send documents
 *  (move into core/selectors.ts when that file is next revised). */
const SEND_LABEL_RE = /send/i;

function findSendButton(): HTMLButtonElement | null {
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]"))) {
    if (b.closest("#cc-root")) continue;
    if (!SEND_LABEL_RE.test(b.getAttribute("aria-label") ?? "")) continue;
    if (b.disabled) continue;
    const r = b.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return b;
  }
  return null;
}

export const enterBehavior: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "session",

  mount(ctx: FeatureContext) {
    let enabled = false; // default OFF — native behavior until told otherwise

    ctx.listen(
      document,
      "keydown",
      (ev: KeyboardEvent) => {
        if (!enabled) return; // OFF ⇒ pure pass-through
        if (ev.key !== "Enter" || ev.isComposing) return;
        if (ev.shiftKey || ev.altKey) return; // native newline paths — untouched
        const composerEl = ctx.composer.find();
        if (!composerEl || !(ev.target instanceof Node) || !composerEl.contains(ev.target)) return;

        if (ev.ctrlKey || ev.metaKey) {
          // Mod+Enter → send via claude's real button. Consume the keystroke
          // either way so ProseMirror can't double-handle it.
          ev.preventDefault();
          ev.stopImmediatePropagation();
          if (!ctx.composer.readDraft().trim()) return; // nothing to send
          findSendButton()?.click(); // armed undo-send intercepts this click
          return;
        }

        // Plain Enter → newline instead of send. stopImmediatePropagation
        // keeps undo-send's later-registered capture listener from arming a
        // countdown for a keystroke that is no longer a send.
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (!ctx.composer.readDraft().trim()) return; // empty composer: native no-op
        ctx.composer.insertText("\n");
      },
      { capture: true },
    );

    // ---- setting (gear-menu Composer row + palette action) -----------------------
    void ctx.storage.getSettings().then((s) => {
      if (ctx.signal.aborted) return;
      enabled = s.enterToNewline;
    });
    ctx.onCleanup(
      ctx.storage.onSettingsChanged((s) => {
        enabled = s.enterToNewline;
      }),
    );
  },
};
