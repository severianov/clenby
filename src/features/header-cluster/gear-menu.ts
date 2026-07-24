/**
 * Tools (gear) dropdown content, hosted by
 * the header cluster's `#cc-pop-tools` popover.
 *
 * Redesign (2026-07 gear-redesign spec): three visually distinct zones, no
 * title bar, no close button — the popover dismisses by clicking the gear
 * again or anywhere outside (header-cluster owns that).
 *
 * Zones:
 * - APPEARANCE — theme CARD GRID (every preset EXCEPT the "default"/Off
 *   preset gets a tile; clicking the ACTIVE card turns styling OFF by
 *   writing activePresetId="default" — no separate Off tile) + the
 *   Light · Dark MODE SEGMENT (role="radiogroup" writing themeMode; a hard
 *   two-way choice — disabled under Off, which is stock claude.ai and
 *   follows the page) + the
 *   [A− | label | A+ | ↺] text-size stepper writing theme TWEAKS.
 * - ACTIONS — Fold/Unfold SEGMENTED PAIR (bus "fold:all"), an ICON-TILE
 *   launcher (Palette, Find — bus toggles; conversation-scoped consumers are
 *   quiet no-ops outside a chat; pop-out lives on the answer toolbar, not
 *   here), the KEYBOARD-SHORTCUTS row (prints the palette chord on its face
 *   and opens the palette's shortcuts reference — @/shared/keymap is the
 *   single source for every chord in the product), a Selector-health status
 *   row with the live degraded count, and the export slot (`#cc-gear-export-slot`) the export feature fills on every
 *   open (features never import features; discovery is by stable id + bus).
 * - TOGGLES — SWITCH rows (name + one-line description, role="switch")
 *   grouped Composer / Trust / Data / Repair / Memory. Each writes its
 *   setting; the owning feature reacts via storage.onChanged. Switch state
 *   reflects the live setting through showSettings/onSettingsChanged.
 *
 * Swatch colors are PRESET-IDENTITY DATA — each preset's curated `swatch` +
 * `swatchFg` tokens. They do not vary with the active theme, so they are
 * threaded through per-card `--cc-swatch` / `--cc-swatch-fg` custom
 * properties rather than hardcoded in CSS (single source of truth stays in
 * the preset JSON).
 */

import { browser } from "wxt/browser";
import type { FeatureContext } from "@/core/feature";
import type { CompanionSettings } from "@/core/storage";
import { ownedEl } from "@/ui/root";
import { kbdSet } from "@/ui/kbd";
import {
  ariaKeyShortcuts,
  chordOf,
  chordSpoken,
  chordText,
  type Chord,
} from "@/shared/keymap";
import { PRESET_LIST, DEFAULT_PRESET_ID } from "@/theme/presets";
import { cssColor } from "@/theme/compile";
import type { ThemeModeSetting, ThemeTokens } from "@/theme/tokens";
import type { BridgePairResult, BridgeStatus } from "@/shared/bridge-protocol";

/** The one-line setup command the user runs in their terminal (spec §1/§10). */
// --scope user: without it Claude Code registers the bridge for the CURRENT
// FOLDER only, and sessions in any other project silently have no bridge.
const BRIDGE_SETUP_CMD = "claude mcp add --scope user clenby -- npx clenby-bridge@latest";
const BRIDGE_CODE_CMD = "npx clenby-bridge@latest code";
const BRIDGE_AUDIT_CMD = "npx clenby-bridge@latest audit";
const BRIDGE_ROTATE_CMD = "npx clenby-bridge@latest --rotate-token";
const BRIDGE_REMOVE_TOKEN_CMD = "npx clenby-bridge@latest remove-token";
const BRIDGE_REMOVE_MCP_CMD = "claude mcp remove clenby";

const OWNER = "header-cluster";

const BODY_PX_MIN = 12;
const BODY_PX_MAX = 24;
const BODY_PX_STEP = 1;
const BODY_PX_DEFAULT = 16;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Settings fields a gear switch can flip (booleans only, compile-checked). */
type BoolSettingKey = {
  [K in keyof CompanionSettings]: CompanionSettings[K] extends boolean ? K : never;
}[keyof CompanionSettings];

/** lucide `command` — the palette glyph. Shared with ./index.ts's cluster
 *  button so the tile, the shortcuts row and the header button are one mark. */
export const COMMAND_ICON_PATH =
  "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3";

/** Lucide-style line icon (stroke: currentColor) — same idiom as the
 *  cluster buttons in ./index.ts. `shapes` are [tag, attrs]. */
function lineIcon(shapes: ReadonlyArray<readonly [string, Record<string, string>]>): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

// Action-tile icons (lucide: search, activity, chevrons-down-up,
// chevrons-up-down, sun, moon).
const icons = {
  sun: (): SVGSVGElement =>
    lineIcon([
      ["circle", { cx: "12", cy: "12", r: "4" }],
      ["path", { d: "M12 2v2" }],
      ["path", { d: "M12 20v2" }],
      ["path", { d: "m4.93 4.93 1.41 1.41" }],
      ["path", { d: "m17.66 17.66 1.41 1.41" }],
      ["path", { d: "M2 12h2" }],
      ["path", { d: "M20 12h2" }],
      ["path", { d: "m6.34 17.66-1.41 1.41" }],
      ["path", { d: "m19.07 4.93-1.41 1.41" }],
    ]),
  moon: (): SVGSVGElement =>
    lineIcon([["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }]]),
  find: (): SVGSVGElement =>
    lineIcon([
      ["circle", { cx: "11", cy: "11", r: "8" }],
      ["path", { d: "m21 21-4.3-4.3" }],
    ]),
  command: (): SVGSVGElement => lineIcon([["path", { d: COMMAND_ICON_PATH }]]),
  health: (): SVGSVGElement =>
    lineIcon([
      [
        "path",
        {
          d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
        },
      ],
    ]),
  fold: (): SVGSVGElement =>
    lineIcon([
      ["path", { d: "m7 20 5-5 5 5" }],
      ["path", { d: "m7 4 5 5 5-5" }],
    ]),
  unfold: (): SVGSVGElement =>
    lineIcon([
      ["path", { d: "m7 15 5 5 5-5" }],
      ["path", { d: "m7 9 5-5 5 5" }],
    ]),
};

/** The tile colors that identify a preset in the picker (data, not theming). */
function swatchColor(preset: ThemeTokens): string {
  return cssColor(preset.swatch);
}

/** Per-preset tile flourish: Code shows braces in mono, Book serif "Aa". */
function swatchGlyph(preset: ThemeTokens): { text: string; extraClass: string } {
  if (preset.id === "code") return { text: "{}", extraClass: " cc-sw-mono" };
  if (preset.id === "book") return { text: "Aa", extraClass: " cc-sw-serif" };
  return { text: "Aa", extraClass: "" };
}

/** The switch rows of the Toggles zone, grouped by the final feature set. */
const TOGGLE_GROUPS: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<{ key: BoolSettingKey; name: string; desc: string }>;
}> = [
  {
    group: "Composer",
    items: [
      {
        key: "enterToNewline",
        name: "Enter = newline",
        // Chord text from @/shared/keymap — one spelling, everywhere.
        desc: `Enter inserts a newline · ${chordText(chordOf("enterSend"))} sends`,
      },
    ],
  },
  {
    group: "Trust",
    items: [
      {
        key: "secretGuardOn",
        name: "Secret detection",
        desc: "Warn when the draft looks like it holds a key or password",
      },
      {
        key: "mathCheckerOn",
        name: "Math check",
        desc: "Recompute simple arithmetic and mark results that don't add up",
      },
    ],
  },
  {
    group: "Data",
    items: [
      {
        key: "tableToolbarOn",
        name: "Table toolbar",
        desc: "Copy TSV · download CSV · sortable view on tables",
      },
    ],
  },
  {
    group: "Repair",
    items: [
      {
        key: "truncationGuardOn",
        name: "Continue cut-offs",
        desc: "Spot cut-off answers and offer a one-click continue",
      },
      {
        key: "fenceFixerOn",
        name: "Fence fixer",
        desc: "Re-render answers a broken code fence swallowed",
      },
      {
        key: "regenSafetyNetOn",
        name: "Regen safety net",
        desc: "Save the old answer before a retry so a reroll can't lose it",
      },
    ],
  },
  {
    group: "Memory",
    items: [
      {
        key: "liveChecklistsOn",
        name: "Live checklists",
        desc: "Tickable step lists — ticks remembered per chat",
      },
    ],
  },
];

/** Build the three-zone gear-menu content. Appended into `#cc-pop-tools` by
 *  the header cluster; all listeners/subscriptions ride the cluster's ctx. */
export function buildGearMenu(ctx: FeatureContext): HTMLElement {
  const root = ownedEl("div", { owner: OWNER, className: "cc-gear" });

  /** A zone card with its mono eyebrow (the only "title" the menu has). */
  const zone = (eyebrow: string): HTMLDivElement => {
    const z = ownedEl("div", { owner: OWNER, className: "cc-gear-zone" });
    z.appendChild(ownedEl("div", { owner: OWNER, className: "cc-menu-label", text: eyebrow }));
    root.appendChild(z);
    return z;
  };
  const subLabel = (text: string): HTMLDivElement =>
    ownedEl("div", { owner: OWNER, className: "cc-gear-sub", text });

  // =====================================================================
  // ZONE 1 — APPEARANCE
  // =====================================================================
  const appearance = zone("Appearance");

  // Theme card grid — every preset except "default" (the Off preset).
  // Clicking the ACTIVE card turns styling off (activePresetId="default");
  // clicking any other card selects it. No separate Off tile.
  const themeList = ownedEl("div", { owner: OWNER, className: "cc-theme-grid" });
  const themeButtons = new Map<string, HTMLButtonElement>();
  for (const preset of PRESET_LIST) {
    if (preset.id === DEFAULT_PRESET_ID) continue;
    const btn = ownedEl("button", {
      owner: OWNER,
      className: "cc-theme-card",
      attrs: {
        type: "button",
        "data-cc-preset": preset.id,
        title: `${preset.name} — click the active theme again to turn styling off`,
      },
    });
    const glyph = swatchGlyph(preset);
    const tile = ownedEl("span", {
      owner: OWNER,
      className: "cc-theme-sw" + glyph.extraClass,
      text: glyph.text,
    });
    // Identity data threaded as custom props (single source: the preset JSON).
    tile.style.setProperty("--cc-swatch", swatchColor(preset));
    tile.style.setProperty("--cc-swatch-fg", cssColor(preset.swatchFg));
    btn.append(
      tile,
      ownedEl("span", { owner: OWNER, className: "cc-theme-name", text: preset.name }),
      ownedEl("span", { owner: OWNER, className: "cc-theme-ck", text: "✓" }),
    );
    ctx.listen(btn, "click", () => {
      void ctx.storage.getSettings().then((s) => {
        if (ctx.signal.aborted) return;
        // Tap the active card → styling off (the "default" preset is Off).
        const next = s.activePresetId === preset.id ? DEFAULT_PRESET_ID : preset.id;
        return ctx.storage.setSetting("activePresetId", next);
      });
    });
    themeButtons.set(preset.id, btn);
    themeList.appendChild(btn);
  }
  appearance.append(themeList);

  const markActive = (activeId: string): void => {
    for (const [id, btn] of themeButtons) {
      if (id === activeId) btn.setAttribute("data-active", "1");
      else btn.removeAttribute("data-active");
    }
  };

  // Mode segment — Light · Dark writing themeMode (a hard two-way choice; no
  // Auto since 2026-07-22). Themed presets render exactly the chosen half,
  // whatever claude.ai's own appearance says (the themes feature re-applies
  // via storage.onChanged). The Off preset is stock claude.ai and follows the
  // page — the segment disables there so the dead control can't mislead.
  appearance.append(subLabel("Mode"));
  const modeSeg = ownedEl("div", {
    owner: OWNER,
    className: "cc-gear-seg cc-mode-seg",
    attrs: { role: "radiogroup", "aria-label": "Light / dark mode" },
  });
  const modeButtons = new Map<ThemeModeSetting, HTMLButtonElement>();
  const MODE_OPTIONS: ReadonlyArray<{
    value: ThemeModeSetting;
    icon: SVGSVGElement;
    text: string;
    title: string;
  }> = [
    { value: "light", icon: icons.sun(), text: "Light", title: "Theme renders light, whatever claude.ai uses" },
    { value: "dark", icon: icons.moon(), text: "Dark", title: "Theme renders dark, whatever claude.ai uses" },
  ];
  for (const opt of MODE_OPTIONS) {
    const b = ownedEl("button", {
      owner: OWNER,
      className: "cc-gear-seg-btn",
      attrs: { type: "button", role: "radio", "aria-checked": "false", title: opt.title },
    });
    b.append(opt.icon, ownedEl("span", { owner: OWNER, text: opt.text }));
    ctx.listen(b, "click", () => void ctx.storage.setSetting("themeMode", opt.value));
    modeButtons.set(opt.value, b);
    modeSeg.appendChild(b);
  }
  appearance.append(modeSeg);
  const markMode = (active: ThemeModeSetting, themedPresetActive: boolean): void => {
    for (const [value, btn] of modeButtons) {
      btn.setAttribute("aria-checked", value === active ? "true" : "false");
      btn.disabled = !themedPresetActive;
      if (!themedPresetActive) {
        btn.title = "Pick a theme first — Off is stock claude.ai and follows its appearance";
      } else {
        const opt = MODE_OPTIONS.find((o) => o.value === value);
        if (opt) btn.title = opt.title;
      }
    }
  };

  // Text size stepper — [A− | label | A+ | ↺] writing theme TWEAKS via
  // ctx.storage (merged over the preset by the compiler, no second
  // stylesheet). ↺ = "Back to theme default" (clears only the size tweak);
  // untweaked label reads "auto" (the theme's own size governs).
  appearance.append(subLabel("Text size"));
  const sizeRow = ownedEl("div", { owner: OWNER, className: "cc-menu-row cc-size-row" });
  const chipBtn = (text: string, title: string): HTMLButtonElement =>
    ownedEl("button", {
      owner: OWNER,
      className: "cc-btn",
      text,
      attrs: { type: "button", title },
    });
  const smaller = chipBtn("A−", "Smaller body text");
  const larger = chipBtn("A+", "Larger body text");
  const reset = chipBtn("↺", "Back to theme default");
  const sizeValue = ownedEl("span", { owner: OWNER, className: "cc-size-val" });
  sizeRow.append(smaller, sizeValue, larger, reset);
  appearance.append(sizeRow);

  /** Effective body px for the current settings (tweak > preset > default). */
  const effectiveBodyPx = (activePresetId: string, tweakPx: number | undefined): number => {
    if (tweakPx !== undefined) return tweakPx;
    const preset = PRESET_LIST.find((p) => p.id === activePresetId);
    return preset?.typography.bodySizePx ?? BODY_PX_DEFAULT;
  };

  const nudge = async (delta: number): Promise<void> => {
    const s = await ctx.storage.getSettings();
    if (ctx.signal.aborted) return;
    const current = effectiveBodyPx(s.activePresetId, s.tweaks.bodySizePx);
    const next = Math.min(BODY_PX_MAX, Math.max(BODY_PX_MIN, current + delta));
    await ctx.storage.setSetting("tweaks", { ...s.tweaks, bodySizePx: next });
  };
  ctx.listen(smaller, "click", () => void nudge(-BODY_PX_STEP));
  ctx.listen(larger, "click", () => void nudge(BODY_PX_STEP));
  ctx.listen(reset, "click", () => {
    void ctx.storage.getSettings().then((s) => {
      if (ctx.signal.aborted) return;
      const { bodySizePx: _dropped, ...rest } = s.tweaks;
      return ctx.storage.setSetting("tweaks", rest);
    });
  });

  // =====================================================================
  // ZONE 2 — ACTIONS
  // =====================================================================
  const actions = zone("Actions");

  // Fold/Unfold segmented pair — broadcasts bus "fold:all" (the folding
  // feature owns the actual collapsing).
  const seg = ownedEl("div", { owner: OWNER, className: "cc-gear-seg" });
  const segBtn = (icon: SVGSVGElement, text: string, title: string): HTMLButtonElement => {
    const b = ownedEl("button", {
      owner: OWNER,
      className: "cc-gear-seg-btn",
      attrs: { type: "button", title },
    });
    b.append(icon, ownedEl("span", { owner: OWNER, text }));
    return b;
  };
  const foldAll = segBtn(icons.fold(), "Fold all", "Collapse every message to its first line");
  const unfoldAll = segBtn(icons.unfold(), "Unfold all", "Expand every message");
  ctx.listen(foldAll, "click", () => ctx.bus.emit("fold:all", { folded: true }));
  ctx.listen(unfoldAll, "click", () => ctx.bus.emit("fold:all", { folded: false }));
  seg.append(foldAll, unfoldAll);
  actions.append(seg);

  // Icon-tile launcher. Every tile is a bus toggle; the owning features hold
  // the panels/overlays (conversation-scoped ones are quiet no-ops outside a
  // chat). A tile with a chord announces it (aria-label + aria-keyshortcuts)
  // but does NOT print it: the cell is ~79px wide and a chip would overflow.
  // The chord is printed full-width on the shortcuts row just below.
  const tiles = ownedEl("div", { owner: OWNER, className: "cc-gear-tiles" });
  const tile = (
    icon: SVGSVGElement,
    text: string,
    title: string,
    chord?: Chord,
  ): HTMLButtonElement => {
    const b = ownedEl("button", {
      owner: OWNER,
      className: "cc-gear-tile",
      attrs: { type: "button", title },
    });
    b.append(icon, ownedEl("span", { owner: OWNER, text }));
    if (chord) {
      b.setAttribute("aria-label", `${text} — ${chordSpoken(chord)}`);
      b.setAttribute("aria-keyshortcuts", ariaKeyShortcuts(chord));
    }
    return b;
  };
  // The palette had NO gear entry at all, and its only label anywhere was a
  // tooltip on an unlabelled glyph. The grid is repeat(3,1fr) holding one
  // tile — this fills a free cell, so it costs zero height.
  const paletteTile = tile(
    icons.command(),
    "Palette",
    `Command palette — jump to any chat or message, run any action (${chordText(
      chordOf("palette"),
    )})`,
    chordOf("palette"),
  );
  const findTile = tile(
    icons.find(),
    "Find",
    `Find in conversation — searches every message, even ones not on screen (${chordText(
      chordOf("find"),
    )})`,
    chordOf("find"),
  );
  ctx.listen(paletteTile, "click", () => ctx.bus.emit("ui:palette-toggle", {}));
  ctx.listen(findTile, "click", () => ctx.bus.emit("ui:find-toggle", {}));
  tiles.append(paletteTile, findTile);
  actions.append(tiles);

  // Keyboard shortcuts — the ONE place the gear PRINTS a chord.
  // RULE: the chips live on the FACE. Never replace them with the bare word
  // "Shortcuts", and never demote them into the tooltip — a hover-only chord
  // is the exact problem this row exists to fix. Geometry is the
  // selector-health row's (joined in companion.css: icon + name +
  // right-aligned metadata slot). Click opens the command palette on its
  // shortcuts reference (bus — features never import features).
  const paletteChord = chordOf("palette");
  const keysBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-gear-keys",
    attrs: {
      type: "button",
      title: `Every key Clenby binds (${chordText(paletteChord)})`,
      "aria-label": `Keyboard shortcuts — ${chordSpoken(paletteChord)} opens the command palette`,
      "aria-keyshortcuts": ariaKeyShortcuts(paletteChord),
    },
  });
  keysBtn.append(
    icons.command(),
    ownedEl("span", { owner: OWNER, className: "cc-gear-keys-name", text: "Keyboard shortcuts" }),
    kbdSet(OWNER, paletteChord),
  );
  ctx.listen(keysBtn, "click", () => ctx.bus.emit("ui:palette-shortcuts", {}));
  actions.append(keysBtn);

  // Selector-health status row — the selector-health feature owns the
  // dashboard panel; this row emits the bus toggle (session-scoped
  // subscriber — always lands) and carries the one-line degraded count,
  // read straight from the health ledgers (ctx.selectors / ctx.overrides).
  // No transition event fires on recovery, so the count also refreshes on a
  // slow poll.
  const healthBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-gear-health",
    attrs: {
      type: "button",
      title: "Every anchor into claude.ai — live status, overrides, repair",
    },
  });
  const healthCount = ownedEl("span", { owner: OWNER, className: "cc-gear-health-count" });
  healthBtn.append(
    icons.health(),
    ownedEl("span", { owner: OWNER, className: "cc-gear-health-name", text: "Selector health" }),
    healthCount,
  );
  ctx.listen(healthBtn, "click", () => ctx.bus.emit("ui:selector-health-toggle", {}));
  const refreshHealthCount = (): void => {
    let degraded = 0;
    for (const h of ctx.selectors.health().values()) {
      if (h.state === "fallback" || h.state === "broken") degraded++;
    }
    for (const h of ctx.overrides.endpointHealth().values()) {
      if (h.state === "fallback" || h.state === "broken") degraded++;
    }
    healthCount.textContent =
      degraded === 0 ? "all anchors ok" : `${degraded} anchor${degraded === 1 ? "" : "s"} degraded`;
    healthCount.classList.toggle("cc-gear-degraded", degraded > 0);
  };
  refreshHealthCount();
  ctx.on("selector:degraded", () => refreshHealthCount());
  ctx.setInterval(refreshHealthCount, 5000);
  actions.append(healthBtn);

  // Export — the mount-point slot the export feature fills with its own
  // rows on every gear open (`ui:export-open`; features never import
  // features — discovery is by the stable `#cc-gear-export-slot` id).
  actions.append(subLabel("Export for Claude Code"));
  const exportSlot = ownedEl("div", {
    owner: OWNER,
    className: "cc-gear-export",
    attrs: { id: "cc-gear-export-slot" },
  });
  // Placeholder the export feature replaces when it mounts (it clears the
  // slot's children before rendering its own controls).
  exportSlot.append(
    ownedEl("span", { owner: OWNER, className: "cc-faint", text: "Open a conversation to export" }),
  );
  actions.append(exportSlot);

  // =====================================================================
  // ZONE — CLAUDE CODE BRIDGE (pairing + live status, spec §3/§5)
  // =====================================================================
  const bridge = zone("Claude Code");
  bridge.id = "cc-gear-ccb"; // scroll/flash target for the composer-chip shortcut
  let bridgeStatus: BridgeStatus = { paired: false, hasPermission: false, sessions: [] };
  let expanded = false;

  // ---- Terminal skin ("clenby-bridge") -----------------------------------
  // The whole zone renders as a tiny terminal window. Its frame + palette are
  // deliberately FIXED-DARK on every theme (a terminal is dark), so the colors
  // are literal in companion.css, not var(--cc-*) tokens. All state logic below
  // is preserved from the previous card — this is a reskin, not a rewrite.
  const tSpan = (cls: string, text: string): HTMLSpanElement =>
    ownedEl("span", { owner: OWNER, className: cls, text });

  // Non-interactive prompt line: "$ <rest>".
  const promptLine = (rest: string, restCls = "cc-cct-tx"): HTMLDivElement => {
    const line = ownedEl("div", { owner: OWNER, className: "cc-cct-line" });
    line.append(tSpan("cc-cct-prompt", "$"), tSpan(restCls, ` ${rest}`));
    return line;
  };
  // Status line: colored glyph + text (e.g. "○ not linked").
  const glyphLine = (glyph: string, glyphCls: string, rest: string): HTMLDivElement => {
    const line = ownedEl("div", { owner: OWNER, className: "cc-cct-line" });
    line.append(tSpan(`cc-cct-gl ${glyphCls}`, glyph), tSpan("cc-cct-tx", ` ${rest}`));
    return line;
  };
  // "# comment" line — dim by default; danger for the uninstall title.
  const commentLine = (text: string, colorCls = "cc-cct-dim"): HTMLDivElement =>
    ownedEl("div", { owner: OWNER, className: `cc-cct-line ${colorCls}`, text });
  // Blank vertical gap — one line of the body's 1.75 rhythm (aria-hidden).
  const spacer = (): HTMLDivElement =>
    ownedEl("div", { owner: OWNER, className: "cc-cct-spacer", attrs: { "aria-hidden": "true" } });
  // Decorative "---" divider — dim, mono (inherited), non-interactive.
  const sepLine = (): HTMLDivElement =>
    ownedEl("div", {
      owner: OWNER,
      className: "cc-cct-line cc-cct-dim",
      text: "---",
      attrs: { "aria-hidden": "true" },
    });
  // Copyable command line: "$ <cmd> ⧉". data-cc-cmd is the single source for the
  // copied text, so what's shown and what's copied can never drift.
  const cmdLine = (cmd: string): HTMLButtonElement => {
    const b = ownedEl("button", {
      owner: OWNER,
      className: "cc-cct-line cc-cct-cmd",
      attrs: { type: "button", title: "Click to copy", "aria-label": `Copy command: ${cmd}` },
    });
    b.dataset["ccCmd"] = cmd;
    b.append(
      tSpan("cc-cct-prompt", "$"),
      tSpan("cc-cct-cmdtx", ` ${cmd}`),
      ownedEl("span", {
        owner: OWNER,
        className: "cc-cct-copy",
        text: "⧉",
        attrs: { "aria-hidden": "true" },
      }),
    );
    return b;
  };
  // Clickable action line styled as a terminal command (no copy glyph).
  const promptBtn = (title: string): HTMLButtonElement => {
    const b = ownedEl("button", {
      owner: OWNER,
      className: "cc-cct-line cc-cct-btn",
      attrs: { type: "button", title, "aria-label": title },
    });
    b.append(tSpan("cc-cct-prompt", "$"));
    return b;
  };

  // Frame: title bar (three dots + mono label) over a dark body.
  const term = ownedEl("div", { owner: OWNER, className: "cc-cct" });
  const bar = ownedEl("div", { owner: OWNER, className: "cc-cct-bar" });
  const dots = ownedEl("div", {
    owner: OWNER,
    className: "cc-cct-dots",
    attrs: { "aria-hidden": "true" },
  });
  dots.append(
    ownedEl("span", { owner: OWNER, className: "cc-cct-tdot" }),
    ownedEl("span", { owner: OWNER, className: "cc-cct-tdot" }),
    ownedEl("span", { owner: OWNER, className: "cc-cct-tdot" }),
  );
  const barLabel = ownedEl("span", {
    owner: OWNER,
    className: "cc-cct-tlabel",
    text: "clenby-bridge",
  });
  bar.append(dots, barLabel);
  const body = ownedEl("div", { owner: OWNER, className: "cc-cct-body" });
  term.append(bar, body);
  bridge.append(term);

  // ---- NOT-LINKED group: status + setup/advanced entries -----------------
  const grpNotLinked = ownedEl("div", { owner: OWNER, className: "cc-cct-grp" });
  const setupLine = promptBtn("Set up the Claude Code bridge");
  setupLine.append(tSpan("cc-cct-accent", " clenby setup"));
  const advancedLine = promptBtn("Show install, uninstall and audit commands");
  advancedLine.append(
    tSpan("cc-cct-tx", " clenby advanced"),
    tSpan("cc-cct-dim", " — install / uninstall / audit"),
  );
  advancedLine.setAttribute("aria-expanded", "false");
  // Advanced block (reachable ONLY while not linked — owner rule).
  const advancedBlock = ownedEl("div", { owner: OWNER, className: "cc-cct-adv cc-hidden" });
  advancedBlock.append(
    commentLine("# check what the bridge runs"),
    cmdLine(BRIDGE_AUDIT_CMD),
    spacer(),
    commentLine("# rotate the pairing token"),
    cmdLine(BRIDGE_ROTATE_CMD),
    spacer(),
  );
  const removeBox = ownedEl("div", { owner: OWNER, className: "cc-cct-remove" });
  removeBox.append(
    commentLine("# uninstall from your terminal", "cc-cct-danger"),
    cmdLine(BRIDGE_REMOVE_TOKEN_CMD),
    cmdLine(BRIDGE_REMOVE_MCP_CMD),
    commentLine("# after these, no trace remains"),
  );
  advancedBlock.append(removeBox);
  grpNotLinked.append(
    promptLine("clenby status"),
    glyphLine("○", "cc-cct-gold", "not linked"),
    spacer(),
    setupLine,
    sepLine(),
    advancedLine,
    advancedBlock,
  );

  // ---- SETUP group: register · code · paste ------------------------------
  const grpSetup = ownedEl("div", { owner: OWNER, className: "cc-cct-grp cc-hidden" });
  const codeInput = ownedEl("input", {
    owner: OWNER,
    className: "cc-cct-input",
    attrs: {
      type: "text",
      placeholder: "clenby_…",
      spellcheck: "false",
      "aria-label": "Pairing code",
    },
  });
  const pairBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-cct-pair",
    text: "pair",
    attrs: { type: "button" },
  });
  const pairRow = ownedEl("div", { owner: OWNER, className: "cc-cct-pairrow" });
  pairRow.append(codeInput, pairBtn);
  const pairMsg = ownedEl("div", { owner: OWNER, className: "cc-cct-msg" });
  const verifyBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-cct-link",
    text: "verify",
    attrs: { type: "button", "aria-expanded": "false" },
  });
  const cancelBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-cct-link",
    text: "cancel",
    attrs: { type: "button" },
  });
  const setupFoot = ownedEl("div", { owner: OWNER, className: "cc-cct-foot" });
  setupFoot.append(
    tSpan("cc-cct-dim", "loopback only · nothing online · "),
    verifyBtn,
    tSpan("cc-cct-dim", " · "),
    cancelBtn,
  );
  const verifyRow = ownedEl("div", { owner: OWNER, className: "cc-cct-verify cc-hidden" });
  verifyRow.append(cmdLine(BRIDGE_AUDIT_CMD));
  grpSetup.append(
    commentLine("# 1 · register (one time)"),
    cmdLine(BRIDGE_SETUP_CMD),
    spacer(),
    commentLine("# 2 · print your pairing code"),
    cmdLine(BRIDGE_CODE_CMD),
    spacer(),
    commentLine("# 3 · paste it"),
    pairRow,
    pairMsg,
    spacer(),
    setupFoot,
    verifyRow,
  );

  // ---- CONNECTED group: status(⟳) + roster + unpair ----------------------
  const grpConnected = ownedEl("div", { owner: OWNER, className: "cc-cct-grp cc-hidden" });
  const connStatusLine = ownedEl("div", { owner: OWNER, className: "cc-cct-line" });
  const rescanBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-cct-rescan",
    text: "(⟳)",
    attrs: {
      type: "button",
      title: "Rescan for running sessions",
      "aria-label": "Rescan for running Claude Code sessions",
    },
  });
  connStatusLine.append(
    tSpan("cc-cct-prompt", "$"),
    tSpan("cc-cct-tx", " clenby status "),
    rescanBtn,
  );
  const connResultLine = ownedEl("div", { owner: OWNER, className: "cc-cct-line" });
  const connResultGlyph = tSpan("cc-cct-gl", "");
  const connResultText = tSpan("cc-cct-tx", "");
  connResultLine.append(connResultGlyph, connResultText);
  const rosterWrap = ownedEl("div", { owner: OWNER, className: "cc-cct-roster" });
  // Blank lines bracket the session roster; the trailing one collapses when
  // there are no sessions so "linked — no session" keeps a single gap.
  const rosterSpacerTop = spacer();
  const rosterSpacerBot = spacer();
  const unpairLine = promptBtn("Stop the bridge connecting to this browser");
  unpairLine.append(tSpan("cc-cct-danger", " clenby unpair"));
  // Receive hint — the one-command pickup for a handoff sent to this session.
  // Shown only when there IS a live session (hidden in the "linked — no
  // session" variant, same rule as rosterSpacerBot: nothing to receive into).
  // The box carries cc-cct-cmd so the zone's existing delegated copy listener
  // already matches it; cc-cct-recv repaints it as a bordered code chip. No
  // "$" prompt — /mcp__clenby__handoff is a Claude Code slash command, not a
  // shell line.
  const recvHint = ownedEl("div", { owner: OWNER, className: "cc-cct-recv-hint cc-hidden" });
  const recvBox = ownedEl("button", {
    owner: OWNER,
    className: "cc-cct-cmd cc-cct-recv",
    attrs: {
      type: "button",
      title: "Click to copy",
      "aria-label": "Copy command: /mcp__clenby__handoff",
    },
  });
  recvBox.dataset["ccCmd"] = "/mcp__clenby__handoff";
  recvBox.append(
    tSpan("cc-cct-cmdtx", "/mcp__clenby__handoff"),
    ownedEl("span", {
      owner: OWNER,
      className: "cc-cct-copy",
      text: "⧉",
      attrs: { "aria-hidden": "true" },
    }),
  );
  recvHint.append(
    spacer(),
    commentLine("# receive a handoff in this session:"),
    recvBox,
    commentLine("# run it in the terminal after you press send — your words override the intent"),
  );
  grpConnected.append(
    connStatusLine,
    connResultLine,
    rosterSpacerTop,
    rosterWrap,
    rosterSpacerBot,
    unpairLine,
    recvHint,
  );

  body.append(grpNotLinked, grpSetup, grpConnected);

  // ---- state machine (behavior preserved from the card design) -----------
  let advOpen = false;
  const setAdvanced = (open: boolean): void => {
    advOpen = open;
    advancedBlock.classList.toggle("cc-hidden", !open);
    advancedLine.setAttribute("aria-expanded", String(open));
  };
  ctx.listen(advancedLine, "click", () => setAdvanced(!advOpen));
  ctx.listen(verifyBtn, "click", () => {
    const show = verifyRow.classList.contains("cc-hidden");
    verifyRow.classList.toggle("cc-hidden", !show);
    verifyBtn.setAttribute("aria-expanded", String(show));
  });

  // Every "$ … ⧉" line copies its command on click — terminal-shy users
  // shouldn't have to hand-select monospace text. Delegated on the zone.
  ctx.listen(bridge, "click", (ev: MouseEvent) => {
    const chip = ev.target instanceof Element ? ev.target.closest<HTMLElement>(".cc-cct-cmd") : null;
    if (!chip || chip.dataset["ccFlash"]) return;
    const cmd = chip.dataset["ccCmd"] ?? "";
    if (!cmd) return;
    void navigator.clipboard
      .writeText(cmd)
      .then(() => {
        if (ctx.signal.aborted) return;
        const glyph = chip.querySelector<HTMLElement>(".cc-cct-copy");
        if (!glyph) return;
        chip.dataset["ccFlash"] = "1";
        glyph.textContent = "✓";
        chip.classList.add("cc-cct-copied");
        ctx.setTimeout(() => {
          glyph.textContent = "⧉";
          chip.classList.remove("cc-cct-copied");
          delete chip.dataset["ccFlash"];
        }, 900);
      })
      .catch(() => undefined);
  });

  const renderBridge = (): void => {
    const { paired, sessions } = bridgeStatus;
    const showSetup = !paired && expanded;
    const showConnected = paired;
    const showNotLinked = !paired && !expanded;

    barLabel.textContent = showSetup ? "clenby-bridge — setup" : "clenby-bridge";
    grpNotLinked.classList.toggle("cc-hidden", !showNotLinked);
    grpSetup.classList.toggle("cc-hidden", !showSetup);
    grpConnected.classList.toggle("cc-hidden", !showConnected);

    // Advanced is only reachable in the not-linked state.
    if (!showNotLinked) setAdvanced(false);

    if (showConnected) {
      connResultText.className = "cc-cct-tx";
      if (sessions.length > 0) {
        connResultGlyph.className = "cc-cct-gl cc-cct-green";
        connResultGlyph.textContent = "●";
        connResultText.textContent = ` connected — ${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
      } else {
        connResultGlyph.className = "cc-cct-gl cc-cct-gold";
        connResultGlyph.textContent = "○";
        connResultText.textContent = " linked — no session";
      }
      rosterWrap.replaceChildren();
      for (const s of sessions) {
        const time = s.startedAt ? new Date(s.startedAt) : null;
        const hhmm =
          time && !Number.isNaN(time.getTime())
            ? `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
            : "";
        const row = ownedEl("div", { owner: OWNER, className: "cc-cct-line cc-cct-rrow" });
        row.append(
          tSpan("cc-cct-gl cc-cct-green", "◍"),
          tSpan(
            "cc-cct-rname",
            s.petname ? `${s.project} · ${s.petname}` : `${s.project} · ${s.shortId}`,
          ),
          tSpan("cc-cct-rtime", hhmm),
        );
        rosterWrap.append(row);
      }
      // Collapse the trailing blank when there's no roster, so the status pair
      // and "$ clenby unpair" keep a single gap between them.
      rosterSpacerBot.classList.toggle("cc-hidden", sessions.length === 0);
      // Same rule for the receive hint: there's nothing to receive into with no
      // session, so it hides alongside the roster in the "linked — no session"
      // variant and returns once a session appears.
      recvHint.classList.toggle("cc-hidden", sessions.length === 0);
    }

    // Leaving setup clears any pairing status/error.
    if (!showSetup) {
      pairMsg.textContent = "";
      pairMsg.classList.remove("cc-cct-err");
    }
  };

  const loadStatus = (): void => {
    void browser.runtime
      .sendMessage({ type: "cc:bridge:status" })
      .then((s: unknown) => {
        if (ctx.signal.aborted) return;
        if (typeof s === "object" && s !== null && "sessions" in s) {
          bridgeStatus = s as BridgeStatus;
          renderBridge();
        }
      })
      .catch(() => undefined);
  };

  ctx.listen(setupLine, "click", () => {
    expanded = true;
    renderBridge();
    ctx.setTimeout(() => codeInput.focus(), 30);
  });
  ctx.listen(cancelBtn, "click", () => {
    expanded = false;
    renderBridge();
  });
  ctx.listen(rescanBtn, "click", () => {
    // Swap the status result to "… scanning" until the fresh scan lands.
    connResultGlyph.className = "cc-cct-gl cc-cct-dim";
    connResultGlyph.textContent = "…";
    connResultText.className = "cc-cct-tx cc-cct-dim";
    connResultText.textContent = " scanning";
    void browser.runtime.sendMessage({ type: "cc:bridge:rescan" }).catch(() => undefined);
    // Freshly found sessions need a beat to complete the welcome handshake.
    ctx.setTimeout(loadStatus, 900);
  });
  ctx.listen(pairBtn, "click", () => {
    const code = codeInput.value.trim();
    if (!code) {
      pairMsg.textContent = "paste the pairing code from your terminal first";
      pairMsg.classList.add("cc-cct-err");
      return;
    }
    pairBtn.setAttribute("disabled", "true");
    pairMsg.classList.remove("cc-cct-err");
    pairMsg.textContent = "pairing…";
    void browser.runtime
      .sendMessage({ type: "cc:bridge:pair", code })
      .then((res: unknown) => {
        if (ctx.signal.aborted) return;
        pairBtn.removeAttribute("disabled");
        const r = res as BridgePairResult | undefined;
        if (r && r.ok) {
          bridgeStatus = r.status;
          expanded = false;
          codeInput.value = "";
          renderBridge();
        } else {
          pairMsg.textContent = r?.reason ?? "pairing failed — try again";
          pairMsg.classList.add("cc-cct-err");
        }
      })
      .catch(() => {
        if (ctx.signal.aborted) return;
        pairBtn.removeAttribute("disabled");
        pairMsg.textContent = "pairing failed — try again";
        pairMsg.classList.add("cc-cct-err");
      });
  });
  ctx.listen(unpairLine, "click", () => {
    void browser.runtime.sendMessage({ type: "cc:bridge:forget" }).catch(() => undefined);
    bridgeStatus = { paired: false, hasPermission: false, sessions: [] };
    expanded = false;
    setAdvanced(false);
    renderBridge();
  });

  // Live roster updates from the claude-code-bridge feature (session-scoped
  // producer; the gear menu is built under the header-cluster's session ctx).
  ctx.on("bridge:changed", ({ sessions, paired }) => {
    bridgeStatus = { paired, hasPermission: bridgeStatus.hasPermission, sessions };
    renderBridge();
  });
  // Chip shortcut: land the user inside the setup flow, not just near it.
  ctx.on("ui:bridge-setup", () => {
    if (!bridgeStatus.paired) {
      expanded = true;
      renderBridge();
      ctx.setTimeout(() => codeInput.focus(), 150);
    }
  });
  loadStatus();
  renderBridge();

  // =====================================================================
  // ZONE 3 — TOGGLES
  // =====================================================================
  const toggles = zone("Toggles");

  // Each row is a role="switch" button (name + one-line desc + track/knob).
  // Clicking flips the setting; the owning feature reacts via
  // storage.onChanged. aria-checked reflects the live setting through
  // showSettings below (CSS paints the switch off aria-checked only).
  const switchButtons = new Map<BoolSettingKey, HTMLButtonElement>();
  const flip = (key: BoolSettingKey): void => {
    void ctx.storage.getSettings().then((s) => {
      if (ctx.signal.aborted) return;
      return ctx.storage.setSetting(key, !s[key]);
    });
  };
  for (const { group, items } of TOGGLE_GROUPS) {
    toggles.append(subLabel(group));
    for (const item of items) {
      const row = ownedEl("button", {
        owner: OWNER,
        className: "cc-gear-toggle",
        attrs: { type: "button", role: "switch", "aria-checked": "false" },
      });
      const text = ownedEl("span", { owner: OWNER, className: "cc-gear-tg-text" });
      text.append(
        ownedEl("span", { owner: OWNER, className: "cc-gear-tg-name", text: item.name }),
        ownedEl("span", { owner: OWNER, className: "cc-gear-tg-desc", text: item.desc }),
      );
      row.append(text, ownedEl("span", { owner: OWNER, className: "cc-gear-sw-track" }));
      ctx.listen(row, "click", () => flip(item.key));
      switchButtons.set(item.key, row);
      toggles.append(row);
    }
  }

  // ---- live settings reflection --------------------------------------------
  const showSettings = (s: CompanionSettings): void => {
    markActive(s.activePresetId);
    // getSettings already resolved legacy "auto"/junk to a hard light/dark.
    markMode(s.themeMode, s.activePresetId !== DEFAULT_PRESET_ID);
    const tweakPx = s.tweaks.bodySizePx;
    sizeValue.textContent = tweakPx === undefined ? "auto" : `${tweakPx}px`;
    for (const [key, btn] of switchButtons) {
      btn.setAttribute("aria-checked", s[key] ? "true" : "false");
    }
  };
  void ctx.storage.getSettings().then((s) => {
    if (ctx.signal.aborted) return;
    showSettings(s);
  });
  ctx.onCleanup(ctx.storage.onSettingsChanged((s) => showSettings(s)));

  return root;
}
