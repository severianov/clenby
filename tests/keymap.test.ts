/**
 * Unit tests for the keymap (shared/keymap.ts) — the single source for every
 * chord Clenby prints. Pure data + printers; no DOM.
 *
 * Invariants under test:
 * 1. Platform is PRESENTATION ONLY. The same chord prints ⇧⌘K on a Mac and
 *    Ctrl+Shift+K elsewhere, in each platform's canonical modifier order, and
 *    no printer can return an empty string.
 * 2. Spoken forms carry no glyphs — "⇧⌘K" read literally is noise.
 * 3. Two keys mean EITHER key, never "press both".
 * 4. The table itself stays coherent: every scope is a declared scope, every
 *    entry has an action, and reference order is declaration order.
 *
 * These assert against IS_MAC rather than hardcoding one platform, so the
 * suite is correct whether it runs on a Linux CI runner or a Mac laptop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IS_MAC,
  KEY_SCOPES,
  KEYMAP_FOOTNOTE,
  SHORTCUTS,
  SHORTCUT_LIST,
  ariaKeyShortcuts,
  chordMods,
  chordOf,
  chordSpoken,
  chordText,
} from "../src/shared/keymap.ts";

// ---------------------------------------------------------------------------
// 1. printing
// ---------------------------------------------------------------------------

test("the palette chord prints in this platform's form", () => {
  const s = chordText(chordOf("palette"));
  assert.equal(s, IS_MAC ? "⇧⌘K" : "Ctrl+Shift+K");
});

test("modifier order is the platform's canonical order", () => {
  // Mac prints ⌥⇧⌘ (Apple HIG); Windows prints Ctrl+Alt+Shift.
  const mods = chordMods({ mods: ["Shift", "Alt", "Mod"], keys: ["X"] });
  assert.deepEqual(mods, IS_MAC ? ["⌥", "⇧", "⌘"] : ["Ctrl", "Alt", "Shift"]);
});

test("Mac joins modifiers with nothing; other platforms use '+'", () => {
  const s = chordText(chordOf("enterSend"));
  assert.equal(s, IS_MAC ? "⌘Enter" : "Ctrl+Enter");
});

test("a bare key prints as itself, with no separator", () => {
  assert.equal(chordText({ keys: ["Esc"] }), "Esc");
  assert.equal(chordMods({ keys: ["Esc"] }).length, 0);
});

test("no printer returns an empty string for any shipped shortcut", () => {
  for (const s of SHORTCUT_LIST) {
    assert.ok(chordText(s.chord).length > 0, `chordText empty for "${s.action}"`);
    assert.ok(chordSpoken(s.chord).length > 0, `chordSpoken empty for "${s.action}"`);
    assert.ok(ariaKeyShortcuts(s.chord).length > 0, `aria empty for "${s.action}"`);
  }
});

// ---------------------------------------------------------------------------
// 2. spoken forms
// ---------------------------------------------------------------------------

test("spoken forms contain no glyphs", () => {
  for (const s of SHORTCUT_LIST) {
    const spoken = chordSpoken(s.chord);
    assert.ok(!/[⌘⇧⌥↑↓]/.test(spoken), `glyph leaked into spoken form: ${spoken}`);
  }
});

test("spoken modifiers use the platform's real names", () => {
  const spoken = chordSpoken(chordOf("palette"));
  assert.equal(spoken, IS_MAC ? "Command Shift K" : "Control Shift K");
});

test("arrows and Esc are spoken as words", () => {
  assert.equal(chordSpoken({ keys: ["↑", "↓"] }), "Up arrow or Down arrow");
  assert.equal(chordSpoken({ keys: ["Esc"] }), "Escape");
});

test("aria-keyshortcuts uses spec key names, not print labels", () => {
  assert.equal(ariaKeyShortcuts(chordOf("palette")), IS_MAC ? "Meta+Shift+K" : "Control+Shift+K");
  assert.equal(ariaKeyShortcuts({ keys: ["Esc"] }), "Escape");
  assert.equal(ariaKeyShortcuts({ keys: ["↓"] }), "ArrowDown");
});

// ---------------------------------------------------------------------------
// 3. "either key"
// ---------------------------------------------------------------------------

test("two keys mean EITHER key, in every printed form", () => {
  const chord = chordOf("miniWindowCheck");
  assert.deepEqual([...chord.keys], ["Space", "Enter"]);
  assert.equal(chordText(chord), "Space / Enter");
  assert.equal(chordSpoken(chord), "Space or Enter");
  // aria-keyshortcuts names a single binding — the first key.
  assert.equal(ariaKeyShortcuts(chord), "Space");
});

// ---------------------------------------------------------------------------
// 4. table coherence
// ---------------------------------------------------------------------------

test("every shortcut declares a known scope and a non-empty action", () => {
  for (const s of SHORTCUT_LIST) {
    assert.ok(KEY_SCOPES.includes(s.scope), `unknown scope "${s.scope}"`);
    assert.ok(s.action.trim().length > 0);
    assert.ok(s.chord.keys.length > 0, `"${s.action}" binds no key`);
  }
});

test("SHORTCUT_LIST is the table in declaration order", () => {
  assert.deepEqual(SHORTCUT_LIST, Object.values(SHORTCUTS));
  assert.equal(SHORTCUT_LIST[0], SHORTCUTS.palette, "the opener leads the reference");
});

test("every scope has at least one shortcut, so no heading renders empty", () => {
  for (const scope of KEY_SCOPES) {
    assert.ok(
      SHORTCUT_LIST.some((s) => s.scope === scope),
      `scope "${scope}" has no rows`,
    );
  }
});

test("the footnote states the two things a row cannot", () => {
  assert.match(KEYMAP_FOOTNOTE, /Ctrl and ⌘ both work/);
  assert.match(KEYMAP_FOOTNOTE, /can't be rebound/);
});
