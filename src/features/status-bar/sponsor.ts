/**
 * Sponsor slot renderer.
 *
 * COMPLIANCE (non-negotiable):
 * - Content is BUNDLED STATIC DATA (text + optional inline SVG path data).
 * - Rendered exclusively through createElement/textContent — never innerHTML,
 *   never fetched, never scriptable.
 * - Renders only in the companion's own status bar (own-UI-only decision).
 *
 * Behavior: a split-flap "departure board" animation cycles
 * the bundled messages every 8 s. Each transition scrambles the remaining
 * characters and locks them in left-to-right (2 frames per character at
 * 40 ms/frame). Skipped entirely under prefers-reduced-motion. Hover
 * highlight + cursor pointer come from the `.cc-ad` class in companion.css;
 * the `href` field is ready for real links (opened with noopener).
 *
 * All timers/listeners are the CALLER's managed ctx resources — this module
 * never touches global timer APIs; it is not a feature itself.
 */

export interface SponsorEntry {
  text: string;
  /** Optional inline SVG path data (single <path d=…>), no markup strings.
   *  Reserved for a real sponsor logo — not rendered by the flap animation
   *  yet (text-only board). */
  svgPathD?: string;
  /** Link opened on click (noopener). null = slot reserved, no link yet. */
  href?: string | null;
}

/** Bundled sponsor rotation — static data only, never fetched. */
export const SPONSOR_MESSAGES: readonly SponsorEntry[] = [
  { text: "ad · your brand here", href: null },
  { text: "☕ buy me a coffee", href: null },
  { text: "⭐ star us on GitHub", href: null },
  { text: "sponsor this slot", href: null },
];

/** Scramble alphabet for the split-flap frames. */
const FLAP_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789·#%&+=";

const FLAP_FRAME_MS = 40;
const FRAMES_PER_LOCK = 2;
const ROTATE_MS = 8000;

/** The managed-resource surface the status bar lends us (its FeatureContext). */
export interface SponsorHost {
  setInterval(fn: () => void, ms: number): void;
  listen(
    target: EventTarget,
    type: string,
    handler: (ev: Event) => void,
    opts?: AddEventListenerOptions,
  ): void;
}

/**
 * Wire the split-flap board into `slot` (a status-bar-owned element carrying
 * the `.cc-ad` class). Timers and the click listener register on the host's
 * managed context, so everything disposes with the status bar.
 */
export function attachSponsorSlot(slot: HTMLElement, host: SponsorHost): void {
  if (SPONSOR_MESSAGES.length === 0) {
    slot.classList.add("cc-hidden");
    return;
  }

  let index = 0;
  let target = SPONSOR_MESSAGES[0]?.text ?? "";
  let frame = 0;
  let animating = false;

  const reducedMotion = (): boolean =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const flapTo = (text: string): void => {
    target = text;
    if (reducedMotion()) {
      animating = false;
      slot.textContent = target;
      return;
    }
    frame = 0;
    animating = true;
  };

  // One persistent frame ticker; no-ops when idle. (ctx.setInterval has no
  // clear handle by design, so the animation is a state machine instead of a
  // start/stop interval.)
  host.setInterval(() => {
    if (!animating) return;
    frame++;
    const locked = Math.floor(frame / FRAMES_PER_LOCK);
    if (locked >= target.length) {
      animating = false;
      slot.textContent = target;
      return;
    }
    let out = "";
    for (let i = 0; i < target.length; i++) {
      out +=
        i < locked
          ? (target[i] ?? "")
          : (FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)] ?? "");
    }
    slot.textContent = out;
  }, FLAP_FRAME_MS);

  // Message rotation.
  host.setInterval(() => {
    index = (index + 1) % SPONSOR_MESSAGES.length;
    flapTo(SPONSOR_MESSAGES[index]?.text ?? "");
  }, ROTATE_MS);

  // Click-through — link field ready; noopener always.
  host.listen(slot, "click", () => {
    const entry = SPONSOR_MESSAGES[index];
    if (entry?.href) window.open(entry.href, "_blank", "noopener");
  });

  slot.title = "Sponsor slot — links coming soon";
  flapTo(target);
}
