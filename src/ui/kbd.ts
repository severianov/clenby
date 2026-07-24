/**
 * Key chips — the one place a chord becomes elements. Real <kbd> semantics,
 * built with ownedEl (there is no innerHTML path in this codebase).
 *
 * A chip set is aria-hidden: "⇧⌘K" read out literally is noise. Callers name
 * the OWNING control with chordSpoken() instead — an aria-label on a <button>
 * or role="option", or the .cc-vh span kbdDefinition() puts inside its <dd>
 * (a <dd>'s role does not support a reliable aria-label).
 */

import { ownedEl } from "./root";
import { chordMods, chordSpoken, type Chord } from "@/shared/keymap";

const chip = (owner: string, text: string): HTMLElement =>
  ownedEl("kbd", { owner, className: "cc-kbd", text });

export function kbdSet(owner: string, chord: Chord): HTMLSpanElement {
  const set = ownedEl("span", {
    owner,
    className: "cc-kbd-set",
    attrs: { "aria-hidden": "true" },
  });
  for (const label of chordMods(chord)) set.appendChild(chip(owner, label));
  chord.keys.forEach((k, i) => {
    // Two keys mean EITHER key — a slash, never bare adjacency (which reads
    // as "press both").
    if (i > 0) {
      set.appendChild(ownedEl("span", { owner, className: "cc-kbd-or", text: "/" }));
    }
    set.appendChild(chip(owner, k));
  });
  return set;
}

/** The <dd> half of a description-list shortcut row: visible chips plus the
 *  spoken chord for screen readers. */
export function kbdDefinition(owner: string, chord: Chord): HTMLElement {
  const dd = ownedEl("dd", { owner, className: "cc-pal-ref-keys" });
  dd.append(
    kbdSet(owner, chord),
    ownedEl("span", { owner, className: "cc-vh", text: chordSpoken(chord) }),
  );
  return dd;
}
