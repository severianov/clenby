/**
 * Mini-window card — DOM builder only (no data, no listeners; index.ts
 * wires those, mirroring the atlas panel.ts split).
 *
 * DESIGN: "Console" (owner-picked from the 2026-07-22 three-way mockup,
 * internal/design/mockups/mini-window-designs.html) — a dense working-
 * reference surface. One card = one popped-out answer:
 *
 *   .cc-mw                      flush block
 *     .cc-mw-strip              STICKY mono status strip — the card's only
 *                               chrome: ● dot · title · counts · [↩] [✕]
 *                               (buttons act via data-cc-act delegation;
 *                               index.ts stamps data-cc-uuid on the root and
 *                               fills .cc-mw-counts after rendering)
 *     .cc-mw-body               rendered markdown, flush, Console-styled
 *
 * The strip doubles as the separator/identity when several cards stack in
 * the PiP column, and stays pinned while a long answer scrolls. No borders,
 * no boxes — the PiP window's native strip is the only window chrome (the
 * "two windows" lesson).
 *
 * All icons are bundled static SVG line icons (stroke: currentColor — colored
 * by CSS classes; no emoji, matching the header-cluster convention).
 */

import { ownedEl } from "@/ui/root";

// Lucide-style line icons — static, trusted markup (bundled constants).
export const ICON_JUMP =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>';
export const ICON_CLOSE =
  '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>';

export interface CardRefs {
  el: HTMLDivElement;
  body: HTMLDivElement;
  /** The strip's right-side counts slot — index.ts fills "3 steps · 2 todos"
   *  after rendering the markdown (empty = hidden by CSS). */
  counts: HTMLSpanElement;
}

export function buildCard(owner: string, title: string): CardRefs {
  const el = ownedEl("div", { owner, className: "cc-mw" });

  const strip = ownedEl("div", { owner, className: "cc-mw-strip", attrs: { title } });
  const counts = ownedEl("span", { owner, className: "cc-mw-counts" });

  const mkBtn = (act: string, label: string, icon: string): HTMLButtonElement => {
    const b = ownedEl("button", {
      owner,
      className: "cc-mw-btn",
      attrs: {
        type: "button",
        title: label,
        "aria-label": label,
        "data-cc-act": act,
      },
    });
    b.innerHTML = icon; // static, trusted markup (bundled icon constants)
    return b;
  };

  strip.append(
    ownedEl("span", { owner, className: "cc-mw-dot", attrs: { "aria-hidden": "true" } }),
    ownedEl("span", { owner, className: "cc-mw-name", text: title }),
    counts,
    mkBtn("jump", "Go to the source message", ICON_JUMP),
    mkBtn("close", "Unpin — remove this answer from the mini-window", ICON_CLOSE),
  );

  const body = ownedEl("div", { owner, className: "cc-mw-body" });

  el.append(strip, body);
  return { el, body, counts };
}
