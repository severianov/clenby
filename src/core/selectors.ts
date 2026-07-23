/**
 * Every claude.ai selector in the codebase, with fallbacks and a debug log of
 * what matched. When claude.ai ships a
 * DOM change, the fix is this one file — selector string literals anywhere
 * else in TS are a lint/review defect.
 *
 * The theme compiler imports the raw strings via {@link sel}; runtime code
 * queries through the {@link Selectors} service so fallback resolution and
 * logging stay in one place. Resolution consults the self-healing override
 * layer (core/overrides.ts) first — shipped defaults always remain in the
 * candidate chain underneath, and with no overrides stored the behavior is
 * identical to the pre-override-layer code path.
 */

import type { OverrideStore, SelectorHealth } from "./overrides";
import { buildAncestorPath } from "@/shared/repair-sketch";

export interface SelectorEntry {
  /** The selector verified against the current claude.ai build. */
  readonly primary: string;
  /** Older/alternative selectors to try when the primary stops matching. */
  readonly fallbacks?: readonly string[];
  readonly description: string;
}

/** Verified on claude.ai build ea95d6d (2026-07). */
export const SELECTORS = {
  /** One rendered message block in the conversation thread. Also the
   *  thread-only guard: companion per-message UI may only render inside it. */
  messageBlock: {
    primary: "[data-test-render-count]",
    description: "one message block in the thread",
  },
  userMessage: {
    primary: '[data-testid="user-message"]',
    description: "user message body",
  },
  assistantMessage: {
    primary: ".font-claude-response",
    description: "Claude message body",
  },
  userBubble: {
    primary: ".bg-bg-300",
    description: "user bubble surface (--msg-bubble-py lives here)",
  },
  codeBlockSurface: {
    primary: ".font-claude-response pre > div",
    description: "code block surface inside answers",
  },
  inlineCode: {
    primary: ".font-claude-response code:not(pre code)",
    description: "inline code inside answers",
  },
  conversationColumn: {
    primary: "main .max-w-3xl",
    description: "conversation column (768px default)",
  },
  mainContent: {
    primary: "main.dframe-content",
    description: "main content — ⚠ paints the page bg OVER body",
  },
  sidebar: {
    primary: "aside.dframe-sidebar",
    description: "left sidebar",
  },
  composerInput: {
    primary: 'div[contenteditable="true"].ProseMirror',
    fallbacks: ['div[contenteditable="true"]'],
    description: "ProseMirror composer contenteditable (last-resort pick)",
  },
  /** Candidate pool for the geometry-based composer picker — a naive query
   *  also matches artifact editors, so ComposerService filters these by
   *  width/bottom position. */
  contentEditable: {
    primary: 'div[contenteditable="true"]',
    description: "any contenteditable — composer-picker candidate pool",
  },
  scrollToBottom: {
    primary: 'button[aria-label="Scroll to bottom"]',
    description: "claude's scroll-to-bottom arrow (status bar shifts it up)",
  },
  /** Primary streaming signal. Verify the aria-label on the live site and
   *  update here if it differs. */
  stopButton: {
    primary: 'button[aria-label="Stop response"]',
    fallbacks: ['button[aria-label="Stop generating"]', '[data-testid="stop-button"]'],
    description: "stop-generation button while Claude is working",
  },
  /** The per-answer retry/regenerate control (regen-safety-net snapshots the
   *  answer BEFORE this fires a reroll). Verify the aria-label on the live
   *  site; the substring fallback keeps the
   *  hook alive across label tweaks ("Retry", "Retry message", …). */
  retryButton: {
    primary: 'button[aria-label="Retry"]',
    fallbacks: [
      '[data-testid="regenerate-button"]',
      'button[aria-label*="retry" i]',
      'button[aria-label*="regenerate" i]',
    ],
    description: "per-answer retry/regenerate button (regen-safety-net snapshot trigger)",
  },
  modelPicker: {
    primary: '[data-testid="model-selector-dropdown"]',
    fallbacks: ['button[aria-haspopup="menu"][data-value]'],
    description: "model picker button (meta-line records model at send time)",
  },
  headerFade: {
    primary: 'main [class*="bg-gradient-to-b"][class*="-bottom-6"]',
    description: "header fade overlay — the light-theme dark-band bug",
  },
  /** The conversation title in the header. Its text color is a MODE LITERAL
   *  on claude's side (white in dark mode, not var-driven — verified live
   *  2026-07-22), so the theme compiler repaints it for the chosen mode. */
  chatTitle: {
    primary: '[data-testid="chat-title-split"]',
    description: "conversation title in the header (mode-literal text — themes repaint it)",
  },
  /** A rendered markdown table inside an answer (table-extractor).
   *  Verified 2026-07-21: the table sits in a `div.overflow-x-auto` scroll
   *  wrapper inside the `standard-markdown` grid — the toolbar attaches as a
   *  SIBLING of that wrapper, never inside the table. */
  assistantTable: {
    primary: ".font-claude-response table",
    description: "markdown table in an answer (parent div.overflow-x-auto is the scroll wrapper)",
  },
  /** Images rendered inside thread messages (image-lightbox). The
   *  feature filters to plain content images (not inside a/button) itself. */
  messageImage: {
    primary: "[data-test-render-count] img",
    description: "an image inside a thread message (lightbox candidate pool)",
  },
  /** ALL iframes — every iframe is hooked, with readability try/caught
   *  per frame. Narrowing to `iframe[srcdoc]`
   *  missed previews whose srcdoc is set via property or that use
   *  src/blob: URLs; console-relay's hook() skips cross-origin frames. */
  artifactIframe: {
    primary: "iframe",
    description: "candidate artifact iframes (readability try/caught per frame — console relay)",
  },
} as const satisfies Record<string, SelectorEntry>;

export type SelectorName = keyof typeof SELECTORS;

/** Raw primary selector string — for CSS building (theme compiler) only. */
export function sel(name: SelectorName): string {
  return SELECTORS[name].primary;
}

/** How often (per name) the matched element's ancestor path is re-captured
 *  for the repair flow's last-match evidence. Queries run in hot polling
 *  loops; a 10 s throttle keeps the capture cost invisible while the
 *  evidence stays fresh enough to sketch from after a breakage. */
const EVIDENCE_THROTTLE_MS = 10_000;

export class Selectors {
  /** Which selector variant matched last, per name — logged once on change. */
  #matched = new Map<SelectorName, string>();

  /** Last evidence-capture time per name ({@link EVIDENCE_THROTTLE_MS}). */
  #evidenceAt = new Map<SelectorName, number>();

  /** The self-healing override layer (core/overrides.ts). Optional so the
   *  service stays constructible bare in tests; without it (or with no
   *  overrides stored) resolution is exactly the shipped defaults. */
  readonly #overrides: OverrideStore | undefined;

  constructor(overrides?: OverrideStore) {
    this.#overrides = overrides;
  }

  /** Override candidates (when present) resolve FIRST; the shipped primary +
   *  fallbacks always stay underneath, so a bad override degrades to current
   *  behavior instead of hard-breaking a feature that still worked. */
  #candidates(name: SelectorName): readonly string[] {
    const entry: SelectorEntry = SELECTORS[name];
    const o = this.#overrides?.selectorOverride(name);
    return o
      ? [o.primary, ...(o.fallbacks ?? []), entry.primary, ...(entry.fallbacks ?? [])]
      : [entry.primary, ...(entry.fallbacks ?? [])];
  }

  #note(name: SelectorName, selector: string, matched?: Element): void {
    const entry: SelectorEntry = SELECTORS[name];
    const via =
      selector === entry.primary
        ? "primary"
        : (entry.fallbacks ?? []).includes(selector)
          ? "fallback"
          : "override";
    // Last-match evidence for the repair flow: remember the matched element's
    // structural ancestor path (throttled — queries run in polling loops) so
    // a later-broken anchor still points at a region to sketch.
    let evidencePath: string | undefined;
    if (matched && this.#overrides) {
      const now = Date.now();
      if (now - (this.#evidenceAt.get(name) ?? 0) >= EVIDENCE_THROTTLE_MS) {
        this.#evidenceAt.set(name, now);
        try {
          evidencePath = buildAncestorPath(matched);
        } catch {
          // Evidence is best-effort — never let it break resolution.
        }
      }
    }
    this.#overrides?.noteSelectorMatch(name, selector, via, evidencePath);
    if (this.#matched.get(name) !== selector) {
      this.#matched.set(name, selector);
      if (via !== "primary") {
        console.debug(`[cc] selector "${name}" matched via ${via}: ${selector}`);
      }
    }
  }

  query<T extends Element = HTMLElement>(name: SelectorName, scope: ParentNode = document): T | null {
    for (const s of this.#candidates(name)) {
      const el = scope.querySelector<Element>(s);
      if (el) {
        this.#note(name, s, el);
        return el as T;
      }
    }
    this.#overrides?.noteSelectorMiss(name);
    return null;
  }

  queryAll<T extends Element = HTMLElement>(name: SelectorName, scope: ParentNode = document): T[] {
    for (const s of this.#candidates(name)) {
      const els = scope.querySelectorAll<Element>(s);
      if (els.length > 0) {
        this.#note(name, s, els[0]);
        return [...els] as T[];
      }
    }
    this.#overrides?.noteSelectorMiss(name);
    return [];
  }

  /** Live per-anchor health ledger — for the future Selector
   *  Health dashboard and any feature. Empty when the override layer is absent. */
  health(): ReadonlyMap<SelectorName, SelectorHealth> {
    return this.#overrides?.selectorHealth() ?? new Map<SelectorName, SelectorHealth>();
  }

  /** True when `el` (or an ancestor) matches the named selector. */
  closest<T extends Element = HTMLElement>(name: SelectorName, el: Element): T | null {
    for (const s of this.#candidates(name)) {
      const hit = el.closest<Element>(s);
      if (hit) return hit as T;
    }
    return null;
  }
}
