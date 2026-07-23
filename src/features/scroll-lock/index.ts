/**
 * Scroll-lock — Reading UX. Conversation scope.
 *
 * While Claude is generating (or the growth fallback says content is being
 * appended), claude.ai keeps yanking the viewport back to the bottom. Once
 * the user has scrolled AWAY from the bottom, this feature suppresses that
 * yank by immediately restoring the user's scroll position; native
 * auto-follow resumes as soon as they return to the bottom band (by any
 * means — scrolling down themselves or claude.ai's own scroll-to-bottom
 * arrow).
 *
 * HOW (own-UI-only, isolated-world honest): a content script cannot patch
 * the page world's scroll APIs, so the ONLY viable suppression is
 * detect-and-undo — classify each scroll event on the conversation scroller
 * as user-initiated (recent wheel/touch/key/scrollbar input) or programmatic,
 * and counter-write `scrollTop` when a programmatic downward yank lands while
 * the user is reading. Setting scroll position is explicitly sanctioned;
 * message DOM is never touched.
 *
 * Shared facts consumed, never re-derived:
 * - streaming state: bus `generation:*` (core/generation.ts — stop-button
 *   primary, growth fallback covers "content being appended" generally).
 * - the scroll container: ctx.matcher.findScroller() (the one resolver,
 *   walking up from the shared messageBlock selector — no inline selectors).
 *
 * Bus: emits `reading:away-changed` — the "user is reading upthread" fact
 * (scroll-lock is the ONE producer; published for any reading-UX consumer).
 *
 * Teardown: all listeners/intervals are ctx-managed; the feature never
 * installs anything persistent, so disposing resources IS the full
 * restoration of native scroll behavior (plus a final away=false emit so no
 * consumer is left believing the user is still away).
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";

const OWNER = "scroll-lock";

/** Within this many px of the bottom the user counts as "at the bottom". */
const BOTTOM_BAND_PX = 120;
/** A scroll event this close to a user input gesture is the user's own. */
const USER_INPUT_WINDOW_MS = 250;
/** Ignore sub-pixel/layout jitter when detecting a downward yank. */
const YANK_SLACK_PX = 4;
/** Truth-maintenance tick (scroller reconnection, height-only changes). */
const RESYNC_MS = 600;
/** Consecutive resync ticks off-bottom before engaging away without input. */
const IDLE_AWAY_TICKS = 2;

/** Keys that scroll the thread when focus is not in an editable. */
const SCROLL_KEYS = new Set([
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  " ",
]);

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA");

export const scrollLock: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    // ---- state ---------------------------------------------------------------
    let scroller: Element | null = null;
    /** The published fact: user is scrolled away from the bottom. */
    let away = false;
    /** Streaming/appending, per the core detector's events. */
    let generating = false;
    /** The reading position we defend against programmatic yanks. */
    let heldTop = 0;
    let lastUserInputAt = 0;
    /** Scrollbar drags: mouse held down ⇒ every scroll is the user's. */
    let pointerDown = false;
    /** The next scroll event is our own counter-write — skip it. */
    let restoring = false;
    let idleAwayTicks = 0;

    const resolve = (): Element => {
      if (!scroller || !scroller.isConnected) scroller = ctx.matcher.findScroller();
      return scroller;
    };

    const distFromBottom = (el: Element): number =>
      el.scrollHeight - el.scrollTop - el.clientHeight;

    const setAway = (next: boolean): void => {
      if (away === next) return;
      away = next;
      ctx.bus.emit("reading:away-changed", { away });
    };

    // ---- user-input classification --------------------------------------------
    const noteUserInput = (): void => {
      lastUserInputAt = Date.now();
    };

    ctx.listen(document, "wheel", noteUserInput, { capture: true, passive: true });
    ctx.listen(document, "touchstart", noteUserInput, { capture: true, passive: true });
    ctx.listen(document, "touchmove", noteUserInput, { capture: true, passive: true });
    ctx.listen(
      document,
      "mousedown",
      () => {
        pointerDown = true;
        noteUserInput();
      },
      { capture: true, passive: true },
    );
    ctx.listen(
      document,
      "mouseup",
      () => {
        pointerDown = false;
      },
      { capture: true, passive: true },
    );
    ctx.listen(
      document,
      "keydown",
      (ev: KeyboardEvent) => {
        if (!SCROLL_KEYS.has(ev.key)) return;
        if (isEditable(ev.target)) return; // typing, not scrolling
        noteUserInput();
      },
      { capture: true, passive: true },
    );

    // ---- streaming state (the ONE detector — we only consume) ----------
    ctx.on("generation:start", () => {
      generating = true;
    });
    // Ticks only fire mid-stream: they also cover a remount that happened
    // after generation:start was emitted (conversation features remount on
    // nav; the start event may predate this mount).
    ctx.on("generation:tick", () => {
      generating = true;
    });
    ctx.on("generation:end", () => {
      generating = false;
    });

    // ---- the suppression core ---------------------------------------------------
    // Scroll events don't bubble but DO capture through document, so this one
    // listener survives React swapping the scroller element mid-conversation.
    ctx.listen(
      document,
      "scroll",
      (ev: Event) => {
        const el = resolve();
        const t = ev.target;
        const isDocScroll =
          t === document &&
          (el === document.scrollingElement || el === document.documentElement);
        if (t !== el && !isDocScroll) return; // some other scrollable (panel, palette)

        if (restoring) {
          // Our own counter-write from the previous yank — swallow it.
          restoring = false;
          return;
        }

        const top = el.scrollTop;
        const nearBottom = distFromBottom(el) <= BOTTOM_BAND_PX;
        idleAwayTicks = 0;

        const isUser =
          pointerDown || Date.now() - lastUserInputAt <= USER_INPUT_WINDOW_MS;
        if (isUser) {
          heldTop = top;
          setAway(!nearBottom);
          return;
        }

        // Programmatic scroll.
        if (away && generating && top > heldTop + YANK_SLACK_PX) {
          // claude's auto-follow yanking a reading user back down — undo it.
          restoring = true;
          el.scrollTop = heldTop;
          return;
        }
        // Any other programmatic move (outline/atlas jump, layout shift) is
        // the new reading reality — adopt it.
        heldTop = top;
        setAway(!nearBottom);
      },
      { capture: true, passive: true },
    );

    // ---- truth maintenance (height changes produce no scroll events) ----------
    ctx.setInterval(() => {
      const el = resolve();
      const nearBottom = distFromBottom(el) <= BOTTOM_BAND_PX;
      if (away && nearBottom) {
        // Content shrank / layout settled back under the band.
        setAway(false);
        idleAwayTicks = 0;
        return;
      }
      if (!away && !nearBottom) {
        // Drifted off-bottom without any scroll event (content appended while
        // native follow didn't fire, e.g. hidden tab). Debounced so a normal
        // append→follow frame gap never flickers the fact.
        idleAwayTicks++;
        if (idleAwayTicks >= IDLE_AWAY_TICKS) {
          heldTop = el.scrollTop;
          setAway(true);
          idleAwayTicks = 0;
        }
        return;
      }
      idleAwayTicks = 0;
    }, RESYNC_MS);

    // Never leave a consumer believing the user is still away: disposing
    // our listeners already restores native behavior in full (we hold no
    // patches, only event subscriptions and counter-writes).
    ctx.onCleanup(() => {
      if (away) ctx.bus.emit("reading:away-changed", { away: false });
    });
  },
};
