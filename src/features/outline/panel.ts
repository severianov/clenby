/**
 * Outline panel DOM — the draggable, viewport-clamped companion panel
 *
 * LANDMINES:
 * - Draggable by the header (⠿ grip hint), with pointer capture,
 *   viewport-clamped.
 * - Header buttons are EXCLUDED from drag start — pointer capture would otherwise
 *   eat their clicks.
 * - Position persisted via settings (panelPos) — index.ts writes it through
 *   ctx.storage on drop.
 * - Geometry via ui/root.setGeometry only; all colors from companion.css
 *   var(--cc-*). z-index comes from the .cc-panel class (Z.panel).
 * - Row order: header → tabs → search row → list
 *   (the search box sits BELOW the tabs; placeholder follows the active tab).
 * - Tab named "Marks" — a word, not an icon.
 */

import type { FeatureContext } from "@/core/feature";
import { ownedEl, setGeometry } from "@/ui/root";

export const PANEL_ID = "cc-panel";

export type TabId = "q" | "a" | "h";

export const TAB_LABELS: ReadonlyArray<readonly [TabId, string]> = [
  ["q", "Questions"],
  ["a", "Answers"],
  ["h", "Marks"],
];

/** Default docking spot: left of the thread, under the header. */
export const DEFAULT_POS = { left: 250, top: 60 } as const;

export interface PanelRefs {
  panel: HTMLDivElement;
  header: HTMLDivElement;
  reindexBtn: HTMLButtonElement;
  tabbar: HTMLDivElement;
  searchInput: HTMLInputElement;
  list: HTMLDivElement;
}

/** Build the panel chrome (no data, no listeners — index.ts wires those). */
export function buildPanel(owner: string): PanelRefs {
  const panel = ownedEl("div", {
    owner,
    className: "cc-panel cc-outline",
    attrs: { id: PANEL_ID },
  });

  const header = ownedEl("div", {
    owner,
    className: "cc-outline-header",
    attrs: { title: "Drag to move" },
  });
  const grip = ownedEl("span", {
    owner,
    className: "cc-grip",
    text: "⠿",
    attrs: { "aria-hidden": "true" },
  });
  const title = ownedEl("span", { owner, className: "cc-outline-title", text: "Clenby" });
  const reindexBtn = ownedEl("button", {
    owner,
    className: "cc-reindex",
    text: "⟳",
    attrs: { type: "button", title: "Re-index the outline" },
  });
  header.append(grip, title, reindexBtn);

  const tabbar = ownedEl("div", { owner, className: "cc-tabbar", attrs: { role: "tablist" } });
  for (const [id, label] of TAB_LABELS) {
    tabbar.append(
      ownedEl("div", {
        owner,
        className: "cc-tab",
        text: label,
        attrs: { "data-tab": id, role: "tab" },
      }),
    );
  }

  const searchRow = ownedEl("div", { owner, className: "cc-search-row" });
  const searchInput = ownedEl("input", {
    owner,
    className: "cc-input",
    attrs: { id: "cc-search", type: "search" },
  });
  searchRow.append(searchInput);

  const list = ownedEl("div", { owner, className: "cc-list", attrs: { id: "cc-list" } });

  panel.append(header, tabbar, searchRow, list);
  return { panel, header, reindexBtn, tabbar, searchInput, list };
}

/** Clamp a position so the panel stays reachable inside the viewport. */
export function clampPos(
  left: number,
  top: number,
  panel: HTMLElement,
): { left: number; top: number } {
  const width = panel.offsetWidth || 280;
  return {
    left: Math.max(4, Math.min(window.innerWidth - width - 4, left)),
    top: Math.max(4, Math.min(window.innerHeight - 80, top)),
  };
}

/**
 * Wire the pointer-capture drag. Header buttons and the
 * search input never start a drag. `onDrop` receives the final clamped
 * position for persistence.
 */
export function wireDrag(
  ctx: FeatureContext,
  refs: PanelRefs,
  onDrop: (pos: { left: number; top: number }) => void,
): void {
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;

  ctx.listen(refs.header, "pointerdown", (e: PointerEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    // Header buttons excluded from drag start — capture was eating clicks.
    if (target?.closest("button, input")) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    const r = refs.panel.getBoundingClientRect();
    ox = r.left;
    oy = r.top;
    try {
      refs.header.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unavailable — drag still works via header events */
    }
    e.preventDefault();
  });

  ctx.listen(refs.header, "pointermove", (e: PointerEvent) => {
    if (!dragging) return;
    const pos = clampPos(ox + e.clientX - sx, oy + e.clientY - sy, refs.panel);
    setGeometry(refs.panel, pos);
  });

  ctx.listen(refs.header, "pointerup", () => {
    if (!dragging) return;
    dragging = false;
    const r = refs.panel.getBoundingClientRect();
    onDrop(clampPos(r.left, r.top, refs.panel));
  });
}
