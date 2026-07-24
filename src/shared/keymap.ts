/**
 * The keymap — the one place a Clenby keystroke is ever spelled.
 *
 * Every surface that names a key reads from here: the gear menu's Keyboard-
 * shortcuts row, the command palette's reference mode and its per-row chips,
 * and every tooltip that mentions a chord. Nothing hardcodes a chord any more,
 * so the surfaces cannot drift apart (they used to spell the same idea three
 * ways: "Ctrl+Shift+K / ⌘⇧K", "Ctrl/Cmd+Shift+F" and "Ctrl/Cmd+Enter").
 *
 * NOT manifest `commands`: Clenby's chords are content-script listeners
 * (command-palette/index.ts, find-in-conversation/index.ts), so they never
 * appear in chrome://extensions/shortcuts, `chrome.commands.getAll()` cannot
 * generate this list, and users cannot rebind them. The table is
 * hand-maintained on purpose — the reference footnote says so in plain words.
 *
 * PLATFORM IS PRESENTATION ONLY. Every handler matches
 * `ev.ctrlKey || ev.metaKey`, so Ctrl fires on a Mac and Cmd fires on
 * Windows/Linux; IS_MAC only picks which modifier to PRINT. A wrong answer
 * shows the other, still-working key — it can never break a binding. The two
 * global chords also match on `ev.code` ("KeyK"/"KeyF") — physical key
 * position — so they survive Dvorak/AZERTY/Colemak and non-Latin layouts.
 *
 * BINDS NOTHING → SURFACED NOWHERE. scroll-lock's PageUp/PageDown/Home/End/
 * Space set is a passive classifier — capture + passive, never
 * preventDefault. It is not a shortcut and must not be added here "for
 * completeness".
 */

type UADataNavigator = Navigator & { userAgentData?: { platform?: string } };

function platformString(): string {
  if (typeof navigator === "undefined") return ""; // importable from a node test runner
  const raw = (navigator as UADataNavigator).userAgentData?.platform ?? navigator.platform;
  return typeof raw === "string" ? raw : "";
}

/** macOS. `userAgentData` is Chromium-only (undefined in Firefox), so the
 *  `navigator.platform` fallback is load-bearing, not decorative — every Mac
 *  browser still reports "MacIntel", Apple Silicon included. Never parse
 *  navigator.userAgent (the string vendors freeze), and never
 *  chrome.runtime.getPlatformInfo (background-only, async). */
export const IS_MAC: boolean = /mac/i.test(platformString());

export type Mod = "Mod" | "Shift" | "Alt";

export interface Chord {
  /** Modifiers; printed in each platform's canonical order. */
  mods?: readonly Mod[];
  /** Non-modifier keys. Two entries mean EITHER key (rendered "Space / Enter"). */
  keys: readonly string[];
}

export type KeyScope = "Anywhere" | "In the composer" | "In a panel";
export const KEY_SCOPES: readonly KeyScope[] = ["Anywhere", "In the composer", "In a panel"];

export interface Shortcut {
  scope: KeyScope;
  chord: Chord;
  /** What it does, in the palette's sentence-case voice. */
  action: string;
  /** Faint second line: the panel, scope or setting that qualifies it. */
  note?: string;
}

// Apple HIG prints ctrl-opt-shift-cmd; Windows prints Ctrl+Alt+Shift.
const MAC_ORDER: readonly Mod[] = ["Alt", "Shift", "Mod"];
const PC_ORDER: readonly Mod[] = ["Mod", "Alt", "Shift"];
const MAC_MOD: Readonly<Record<Mod, string>> = { Mod: "⌘", Shift: "⇧", Alt: "⌥" };
const PC_MOD: Readonly<Record<Mod, string>> = { Mod: "Ctrl", Shift: "Shift", Alt: "Alt" };
/** Spoken forms — glyph soup read literally is noise. */
const SPOKEN_MOD: Readonly<Record<Mod, string>> = {
  Mod: IS_MAC ? "Command" : "Control",
  Shift: "Shift",
  Alt: IS_MAC ? "Option" : "Alt",
};
const SPOKEN_KEY: Readonly<Record<string, string>> = {
  "↑": "Up arrow",
  "↓": "Down arrow",
  Esc: "Escape",
};
/** aria-keyshortcuts uses the spec's own key names, not our print labels. */
const ARIA_KEY: Readonly<Record<string, string>> = {
  "↑": "ArrowUp",
  "↓": "ArrowDown",
  Esc: "Escape",
};

/** `chord`'s modifiers in this platform's print order — computed once and
 *  reused by every printer below. */
function orderedMods(chord: Chord): Mod[] {
  const order = IS_MAC ? MAC_ORDER : PC_ORDER;
  return order.filter((m) => chord.mods?.includes(m) === true);
}

/** The modifier chip labels, in print order (the key chips are `chord.keys`). */
export function chordMods(chord: Chord): string[] {
  const table = IS_MAC ? MAC_MOD : PC_MOD;
  return orderedMods(chord).map((m) => table[m]);
}

/** Flat text for a `title` — "⇧⌘K" on Mac, "Ctrl+Shift+K" elsewhere. */
export function chordText(chord: Chord): string {
  const mods = chordMods(chord);
  const keys = chord.keys.join(" / ");
  if (mods.length === 0) return keys;
  return IS_MAC ? `${mods.join("")}${keys}` : `${mods.join("+")}+${keys}`;
}

/** Spoken form for an `aria-label` — "Command Shift K". */
export function chordSpoken(chord: Chord): string {
  const mods = orderedMods(chord).map((m) => SPOKEN_MOD[m]);
  const keys = chord.keys.map((k) => SPOKEN_KEY[k] ?? k).join(" or ");
  return [...mods, keys].join(" ");
}

/** `aria-keyshortcuts` value. */
export function ariaKeyShortcuts(chord: Chord): string {
  const mods = (chord.mods ?? []).map((m) => (m === "Mod" ? (IS_MAC ? "Meta" : "Control") : m));
  const first = chord.keys[0] ?? "";
  return [...mods, ARIA_KEY[first] ?? first].join("+");
}

// Declaration order IS reference order.
const TABLE = {
  palette: {
    scope: "Anywhere",
    chord: { mods: ["Mod", "Shift"], keys: ["K"] },
    action: "Open or close the command palette",
    note: "Every claude.ai page, in or out of a chat",
  },
  find: {
    scope: "Anywhere",
    chord: { mods: ["Mod", "Shift"], keys: ["F"] },
    action: "Find in this conversation — searches every message, even ones off screen",
    note: "Inside a chat only · your browser's own Ctrl+F still works",
  },
  escAny: {
    scope: "Anywhere",
    chord: { keys: ["Esc"] },
    action: "Close whatever Clenby has open — menu, panel, overlay",
  },
  enterNewline: {
    scope: "In the composer",
    chord: { keys: ["Enter"] },
    action: "Insert a newline instead of sending",
    note: "Needs Enter = newline switched on",
  },
  enterSend: {
    scope: "In the composer",
    chord: { mods: ["Mod"], keys: ["Enter"] },
    action: "Send",
    note: "Needs Enter = newline switched on",
  },
  shiftEnter: {
    scope: "In the composer",
    chord: { mods: ["Shift"], keys: ["Enter"] },
    action: "Newline — Clenby never touches this one",
  },
  undoCancel: {
    scope: "In the composer",
    chord: { keys: ["Esc"] },
    action: "Cancel a send that's counting down",
    note: "Needs undo-send switched on",
  },
  panelMove: {
    scope: "In a panel",
    chord: { keys: ["↑", "↓"] },
    action: "Move the selection",
    note: "Command palette · find bar",
  },
  panelRun: {
    scope: "In a panel",
    chord: { keys: ["Enter"] },
    action: "Run the selected item",
    note: "Command palette",
  },
  findNext: {
    scope: "In a panel",
    chord: { keys: ["Enter"] },
    action: "Jump to the next match",
    note: "Find bar",
  },
  findPrev: {
    scope: "In a panel",
    chord: { mods: ["Shift"], keys: ["Enter"] },
    action: "Jump to the previous match",
    note: "Find bar",
  },
  notesSplit: {
    scope: "In a panel",
    chord: { keys: ["Enter"] },
    action: "Split the line — on a todo line, start a new todo",
    note: "Notes editor",
  },
  notesOutdent: {
    scope: "In a panel",
    chord: { keys: ["Backspace"] },
    action: "At the start of a line: drop the todo box, or merge into the line above",
    note: "Notes editor",
  },
  miniWindowClose: {
    scope: "In a panel",
    chord: { keys: ["Esc"] },
    action: "Close the pinned mini-window",
    note: "Mini-window",
  },
  miniWindowCheck: {
    scope: "In a panel",
    chord: { keys: ["Space", "Enter"] },
    action: "Tick the focused checklist box",
    note: "Mini-window",
  },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof TABLE;
export const SHORTCUTS: Readonly<Record<ShortcutId, Shortcut>> = TABLE;
export const SHORTCUT_LIST: readonly Shortcut[] = Object.values(TABLE);

/** Chord for a stable id. COMPILE-checked — deliberately no runtime throw:
 *  this runs inside buildGearMenu, so a throw would take out the whole gear
 *  menu, not one tooltip. */
export const chordOf = (id: ShortcutId): Chord => SHORTCUTS[id].chord;

/** The three things a row cannot say, printed under the reference. */
export const KEYMAP_FOOTNOTE =
  "Ctrl and ⌘ both work, on every platform and every keyboard layout. These bindings live in the page, so they aren't listed in your browser's extension-shortcuts screen and can't be rebound.";
