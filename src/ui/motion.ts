/**
 * FLIP helpers + prefers-reduced-motion gate.
 * Used by folding (fold/unfold height slide) and flashes. Every animation in
 * the companion goes through here or through companion.css keyframes that are
 * themselves gated on `prefers-reduced-motion`.
 */

export const HEIGHT_ANIM_MS = 280;
/** Per-message stagger for fold-all / unfold-all cascades. */
export const CASCADE_STEP_MS = 35;

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * FLIP height slide:
 * animate `el` from `from`px to `to`px over ~0.28 s, then run `onDone` and
 * clear every inline property we set. Content stays visible while shrinking —
 * the caller applies its structural class in `onDone`, not before.
 *
 * Inline styles here are geometry-only (height/overflow/transition
 * timing). `el.dataset.ccAnim` is the re-entry guard the caller checks.
 *
 * Note on the raw setTimeout: ui/ is a shared primitive, not a feature — the
 * feature-level timer ban covers src/features/**. This timeout is transient (≤ ~0.3 s),
 * self-cleaning, and harmless on a detached node, so it needs no ledger.
 */
export function animateHeight(
  el: HTMLElement,
  from: number,
  to: number,
  onDone?: () => void,
): void {
  el.dataset["ccAnim"] = "1";
  el.style.height = `${from}px`;
  el.style.overflow = "hidden";
  // Force a layout so the transition starts from `from`.
  void el.getBoundingClientRect();
  el.style.transition = `height ${HEIGHT_ANIM_MS / 1000}s cubic-bezier(.25,.7,.3,1)`;
  el.style.height = `${to}px`;
  window.setTimeout(() => {
    try {
      onDone?.();
    } finally {
      el.style.transition = "";
      el.style.height = "";
      el.style.overflow = "";
      delete el.dataset["ccAnim"];
    }
  }, HEIGHT_ANIM_MS + 20);
}
