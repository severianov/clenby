/**
 * The z-index band for every companion surface.
 *
 * Band 30–45. claude.ai's own modals live at z-50 and MUST always cover us —
 * never emit a z-index outside this file, and never go >= 46.
 */
export const Z = {
  /** Per-message gutter controls (fold, pin) sitting in claude's thread. */
  gutter: 30,
  /** Meta lines rendered inside answers. */
  meta: 31,
  /** The pinned status bar above the composer. */
  statusBar: 36,
  /** Floating header cluster + tracked icons (usage, undo). */
  headerCluster: 38,
  /** The outline panel and other draggable top-level panels. */
  panel: 40,
  /** Dropdowns / popovers opened from the panel or header cluster. */
  popover: 42,
  /** Transient chips (selection highlight chip, flashes). */
  chip: 44,
  /** Absolute ceiling — stay below claude's z-50 modal layer. */
  ceiling: 45,
} as const;

export type ZLayer = keyof typeof Z;
