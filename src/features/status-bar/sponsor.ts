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

import { ownedEl } from "@/ui/root";
import { brandMark } from "@/ui/brand";

export interface SponsorEntry {
  text: string;
  /** Show the Clenby mark before the text (@/ui/brand). Static — the flap
   *  animation only ever touches the text node beside it. */
  mark?: true;
  /** Link opened on click (noopener). null = slot reserved, no link yet. */
  href?: string | null;
}

/**
 * Bundled sponsor rotation — static data only, never fetched.
 *
 * SCOPE, deliberately narrow: this slot supports the PROJECT, it does not sell
 * space. "ad · your brand here" and "sponsor this slot" were removed before
 * store submission — a reviewer reads the strings, not the intent, and offering
 * ad inventory rendered on somebody else's product is the exact shape the
 * Chrome Web Store's ad-injection rules target. Keep entries to: support the
 * project, or support the project.
 *
 * The coffee entry stays href-less until clenby.dev/support exists — a dead
 * link is worse than a disabled one. When it lands it points THERE, never at
 * an individual payment provider, so adding or dropping a platform never needs
 * an extension release.
 */
export const SPONSOR_MESSAGES: readonly SponsorEntry[] = [
  { text: "buy me a coffee", mark: true, href: null },
  { text: "⭐ star us on GitHub", href: "https://github.com/severianov/clenby" },
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

  // The board used to be pure textContent on `slot`. It can't stay that way:
  // setting textContent wipes child elements, so an <svg> mark would be
  // destroyed on every one of the 25 animation frames a second. Structure it
  // once instead — a static mark plus a text node the flapper owns — and the
  // animation never touches the mark again.
  slot.textContent = "";
  const mark = brandMark();
  mark.classList.add("cc-ad-mark", "cc-hidden");
  // This module is not a feature and has no OWNER of its own — the slot is
  // already owner-stamped by the status bar, so inherit it and the runtime
  // sweep still finds these nodes.
  const owner = slot.dataset["ccOwner"] ?? "status-bar";
  const textEl = ownedEl("span", { owner, className: "cc-ad-text" });
  slot.append(mark, textEl);

  let index = 0;
  let target = SPONSOR_MESSAGES[0]?.text ?? "";
  let frame = 0;
  let animating = false;

  /** The mark is per-entry, so it toggles on rotation — never mid-flap. */
  const applyMark = (entry: SponsorEntry | undefined): void => {
    mark.classList.toggle("cc-hidden", entry?.mark !== true);
  };

  const reducedMotion = (): boolean =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Per-entry hover affordance: entries with a real link get a "clickable"
   *  tooltip naming the destination host; reserved slots keep the "coming soon"
   *  note. The cursor is always pointer (.cc-ad) and the hover highlight
   *  (companion.css) is the shared visual cue — this only differentiates the
   *  title. The click handler already honors href (opens it with noopener). */
  const applyAffordance = (entry: SponsorEntry | undefined): void => {
    if (!entry?.href) {
      slot.title = "Sponsor slot — links coming soon";
      return;
    }
    let host = "";
    try {
      host = new URL(entry.href).host;
    } catch {
      host = "";
    }
    slot.title = host ? `Open ${host} in a new tab` : "Open in a new tab";
  };

  const flapTo = (text: string): void => {
    target = text;
    if (reducedMotion()) {
      animating = false;
      textEl.textContent = target;
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
      textEl.textContent = target;
      return;
    }
    let out = "";
    for (let i = 0; i < target.length; i++) {
      out +=
        i < locked
          ? (target[i] ?? "")
          : (FLAP_CHARS[Math.floor(Math.random() * FLAP_CHARS.length)] ?? "");
    }
    textEl.textContent = out;
  }, FLAP_FRAME_MS);

  // Message rotation.
  host.setInterval(() => {
    index = (index + 1) % SPONSOR_MESSAGES.length;
    const entry = SPONSOR_MESSAGES[index];
    applyAffordance(entry);
    applyMark(entry);
    flapTo(entry?.text ?? "");
  }, ROTATE_MS);

  // Click-through — link field ready; noopener always.
  host.listen(slot, "click", () => {
    const entry = SPONSOR_MESSAGES[index];
    if (entry?.href) window.open(entry.href, "_blank", "noopener");
  });

  applyAffordance(SPONSOR_MESSAGES[index]);
  applyMark(SPONSOR_MESSAGES[index]);
  flapTo(target);
}
