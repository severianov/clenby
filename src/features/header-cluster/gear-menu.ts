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
 *   launcher (Find — a bus toggle; conversation-scoped consumers are quiet
 *   no-ops outside a chat; pop-out lives on the answer toolbar, not here),
 *   a Selector-health status row with the live degraded count, and the
 *   export slot (`#cc-gear-export-slot`) the export feature fills on every
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
import { PRESET_LIST, DEFAULT_PRESET_ID } from "@/theme/presets";
import { cssColor } from "@/theme/compile";
import type { ThemeModeSetting, ThemeTokens } from "@/theme/tokens";
import type { BridgePairResult, BridgeStatus } from "@/shared/bridge-protocol";

/** The one-line setup command the user runs in their terminal (spec §1/§10). */
const BRIDGE_SETUP_CMD = "claude mcp add clenby -- npx clenby-bridge@latest";
const BRIDGE_CODE_CMD = "npx clenby-bridge@latest code";
const BRIDGE_AUDIT_CMD = "npx clenby-bridge@latest audit";
const BRIDGE_ROTATE_CMD = "npx clenby-bridge@latest --rotate-token";

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
        desc: "Enter inserts a newline; Ctrl/Cmd+Enter sends",
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
  // chat).
  const tiles = ownedEl("div", { owner: OWNER, className: "cc-gear-tiles" });
  const tile = (icon: SVGSVGElement, text: string, title: string): HTMLButtonElement => {
    const b = ownedEl("button", {
      owner: OWNER,
      className: "cc-gear-tile",
      attrs: { type: "button", title },
    });
    b.append(icon, ownedEl("span", { owner: OWNER, text }));
    return b;
  };
  const findTile = tile(
    icons.find(),
    "Find",
    "Find in conversation — searches every message, even ones not on screen (Ctrl/Cmd+Shift+F)",
  );
  ctx.listen(findTile, "click", () => ctx.bus.emit("ui:find-toggle", {}));
  tiles.append(findTile);
  actions.append(tiles);

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
  let bridgeStatus: BridgeStatus = { paired: false, hasPermission: false, sessions: [] };
  let expanded = false;

  // Status header: colored dot + one line + (when paired) an inline Rescan.
  const statusHead = ownedEl("div", { owner: OWNER, className: "cc-ccb-head" });
  const statusDot = ownedEl("span", {
    owner: OWNER,
    className: "cc-ccb-head-dot",
    attrs: { "aria-hidden": "true" },
  });
  const statusRow = ownedEl("span", { owner: OWNER, className: "cc-ccb-status" });
  statusHead.append(statusDot, statusRow);
  bridge.append(statusHead);

  // Roster (connected sessions).
  const roster = ownedEl("div", { owner: OWNER, className: "cc-ccb-roster" });
  bridge.append(roster);

  /** A copy-on-click command chip (the zone-level listener animates it). */
  const cmdChip = (cmd: string): HTMLElement =>
    ownedEl("code", {
      owner: OWNER,
      className: "cc-ccb-cmd",
      text: cmd,
      attrs: { title: "Click to copy" },
    });

  // The explainer panel — shown BEFORE the browser's own (unalterable)
  // permission prompt (spec §5). Copy is verbatim.
  const pairPanel = ownedEl("div", { owner: OWNER, className: "cc-ccb-pair" });
  pairPanel.append(
    ownedEl("div", { owner: OWNER, className: "cc-ccb-pair-title", text: "Connect to Claude Code" }),
    ownedEl("div", {
      owner: OWNER,
      className: "cc-ccb-pair-body",
      text:
        "A private link on your own computer — nothing is ever sent online. Your browser will " +
        "ask once to allow 127.0.0.1: that's your machine's local address, not a website.",
    }),
  );

  /** One numbered step: a badge + label row, then an indented body. */
  const step = (n: string, label: string): HTMLElement => {
    const head = ownedEl("div", { owner: OWNER, className: "cc-ccb-step" });
    head.append(
      ownedEl("span", { owner: OWNER, className: "cc-ccb-step-n", text: n }),
      ownedEl("span", { owner: OWNER, className: "cc-ccb-step-l", text: label }),
    );
    const body = ownedEl("div", { owner: OWNER, className: "cc-ccb-step-b" });
    pairPanel.append(head, body);
    return body;
  };

  step("1", "Register the bridge — one line, one time").append(cmdChip(BRIDGE_SETUP_CMD));
  step("2", "Print your pairing code").append(cmdChip(BRIDGE_CODE_CMD));
  const step3 = step("3", "Paste the code and pair");
  const codeInput = ownedEl("input", {
    owner: OWNER,
    className: "cc-input cc-ccb-code",
    attrs: { type: "text", placeholder: "clenby_…", spellcheck: "false" },
  });
  const pairMsg = ownedEl("div", { owner: OWNER, className: "cc-ccb-msg" });
  const pairBtns = ownedEl("div", { owner: OWNER, className: "cc-send-actions" });
  const notNowBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-btn",
    text: "Not now",
    attrs: { type: "button" },
  });
  const pairBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-btn cc-send-go",
    text: "Pair",
    attrs: { type: "button" },
  });
  pairBtns.append(notNowBtn, pairBtn);
  step3.append(codeInput, pairMsg, pairBtns);

  // Trust footnote — checkable, not asked for.
  const trustNote = ownedEl("div", { owner: OWNER, className: "cc-ccb-note" });
  trustNote.append(
    ownedEl("span", {
      owner: OWNER,
      text: "Want proof before trusting it? This fingerprints every file the bridge runs: ",
    }),
    cmdChip(BRIDGE_AUDIT_CMD),
  );
  pairPanel.append(trustNote);
  bridge.append(pairPanel);

  // Every command chip in the zone copies itself on click — terminal-shy
  // users shouldn't have to hand-select monospace text.
  ctx.listen(bridge, "click", (ev: MouseEvent) => {
    const el = ev.target instanceof Element ? ev.target.closest<HTMLElement>("code.cc-ccb-cmd") : null;
    if (!el || el.dataset["ccFlash"]) return;
    const cmd = el.textContent ?? "";
    void navigator.clipboard
      .writeText(cmd)
      .then(() => {
        if (ctx.signal.aborted) return;
        el.dataset["ccFlash"] = "1";
        el.textContent = "copied ✓";
        el.classList.add("cc-ok-text");
        ctx.setTimeout(() => {
          el.textContent = cmd;
          el.classList.remove("cc-ok-text");
          delete el.dataset["ccFlash"];
        }, 900);
      })
      .catch(() => undefined);
  });

  // Collapsed entry (not paired, not expanded) + paired-state utilities.
  const connectBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-btn cc-ccb-connect",
    text: "Connect Claude Code…",
    attrs: { type: "button" },
  });
  const rescanBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-ccb-rescan",
    text: "⟳ Rescan",
    attrs: { type: "button", title: "Look for running Claude Code sessions right now" },
  });
  statusHead.append(rescanBtn);

  // "Terminal commands" drawer — every CLI a paired user might ever need,
  // one click away, each line copyable. This is where rotate-token lives.
  const drawerBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-ccb-drawer-t",
    text: "Terminal commands ▾",
    attrs: { type: "button", "aria-expanded": "false" },
  });
  const drawer = ownedEl("div", { owner: OWNER, className: "cc-ccb-drawer cc-hidden" });
  const cmdRow = (label: string, cmd: string): void => {
    const row = ownedEl("div", { owner: OWNER, className: "cc-ccb-cmdrow" });
    row.append(
      ownedEl("span", { owner: OWNER, className: "cc-ccb-cmdrow-l", text: label }),
      cmdChip(cmd),
    );
    drawer.append(row);
  };
  cmdRow("Pairing code — prints it any time", BRIDGE_CODE_CMD);
  cmdRow("Audit — fingerprint every file it runs", BRIDGE_AUDIT_CMD);
  cmdRow("Rotate token — new code, re-pair once", BRIDGE_ROTATE_CMD);
  drawer.append(
    ownedEl("div", {
      owner: OWNER,
      className: "cc-ccb-note",
      text:
        "To stop a session's bridge: end that Claude Code session, or run /mcp there and " +
        "disable clenby. Nothing keeps running on its own.",
    }),
  );
  let drawerOpen = false;
  const setDrawer = (open: boolean): void => {
    drawerOpen = open;
    drawerBtn.textContent = open ? "Terminal commands ▴" : "Terminal commands ▾";
    drawerBtn.setAttribute("aria-expanded", String(open));
    drawer.classList.toggle("cc-hidden", !open);
  };
  ctx.listen(drawerBtn, "click", () => setDrawer(!drawerOpen));

  const forgetBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-btn cc-ccb-forget",
    text: "Forget",
    attrs: { type: "button", title: "Clear the stored pairing and release the 127.0.0.1 grant" },
  });
  bridge.append(connectBtn, drawerBtn, drawer, forgetBtn);

  const renderBridge = (): void => {
    const { paired, sessions } = bridgeStatus;
    // Status line.
    statusDot.classList.remove("cc-ccb-dot-on", "cc-ccb-dot-idle", "cc-ccb-dot-off");
    if (!paired) {
      statusRow.textContent = "Not connected — pair once to send handoffs.";
      statusRow.classList.remove("cc-ok-text");
      statusDot.classList.add("cc-ccb-dot-off");
    } else if (sessions.length > 0) {
      statusRow.textContent = `Connected — ${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
      statusRow.classList.add("cc-ok-text");
      statusDot.classList.add("cc-ccb-dot-on");
    } else {
      statusRow.textContent = "Paired — start Claude Code to connect.";
      statusRow.classList.remove("cc-ok-text");
      statusDot.classList.add("cc-ccb-dot-idle");
    }
    // Roster.
    roster.replaceChildren();
    for (const s of sessions) {
      const time = s.startedAt ? new Date(s.startedAt) : null;
      const hhmm =
        time && !Number.isNaN(time.getTime())
          ? ` — ${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`
          : "";
      roster.append(
        ownedEl("div", {
          owner: OWNER,
          className: "cc-ccb-roster-row",
          text: `${s.project} ·${s.shortId}${hhmm}`,
        }),
      );
    }
    // Controls visibility.
    const showPanel = !paired && expanded;
    pairPanel.classList.toggle("cc-hidden", !showPanel);
    connectBtn.classList.toggle("cc-hidden", paired || expanded);
    rescanBtn.classList.toggle("cc-hidden", !paired);
    forgetBtn.classList.toggle("cc-hidden", !paired);
    drawerBtn.classList.toggle("cc-hidden", !paired);
    if (!paired) setDrawer(false);
    if (!showPanel) {
      pairMsg.textContent = "";
      pairMsg.classList.remove("cc-danger-text");
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

  ctx.listen(connectBtn, "click", () => {
    expanded = true;
    renderBridge();
    ctx.setTimeout(() => codeInput.focus(), 30);
  });
  ctx.listen(notNowBtn, "click", () => {
    expanded = false;
    renderBridge();
  });
  ctx.listen(rescanBtn, "click", () => {
    statusRow.textContent = "Scanning…";
    statusRow.classList.remove("cc-ok-text");
    void browser.runtime.sendMessage({ type: "cc:bridge:rescan" }).catch(() => undefined);
    // Freshly found sessions need a beat to complete the welcome handshake.
    ctx.setTimeout(loadStatus, 900);
  });
  ctx.listen(pairBtn, "click", () => {
    const code = codeInput.value.trim();
    if (!code) {
      pairMsg.textContent = "Paste the pairing code from your terminal first.";
      pairMsg.classList.add("cc-danger-text");
      return;
    }
    pairBtn.setAttribute("disabled", "true");
    pairMsg.classList.remove("cc-danger-text");
    pairMsg.textContent = "Pairing…";
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
          pairMsg.textContent = r?.reason ?? "Pairing failed — try again.";
          pairMsg.classList.add("cc-danger-text");
        }
      })
      .catch(() => {
        if (ctx.signal.aborted) return;
        pairBtn.removeAttribute("disabled");
        pairMsg.textContent = "Pairing failed — try again.";
        pairMsg.classList.add("cc-danger-text");
      });
  });
  ctx.listen(forgetBtn, "click", () => {
    void browser.runtime.sendMessage({ type: "cc:bridge:forget" }).catch(() => undefined);
    bridgeStatus = { paired: false, hasPermission: false, sessions: [] };
    expanded = false;
    renderBridge();
  });

  // Live roster updates from the claude-code-bridge feature (session-scoped
  // producer; the gear menu is built under the header-cluster's session ctx).
  ctx.on("bridge:changed", ({ sessions, paired }) => {
    bridgeStatus = { paired, hasPermission: bridgeStatus.hasPermission, sessions };
    renderBridge();
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
