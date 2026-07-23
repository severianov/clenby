/**
 * The ONE DOM↔API uuid matcher + jump-to-message seek.
 *
 * Behavior:
 * - uuid matching: probe 40-char samples at 0%/40%/70% of
 *   the rendered text (companion glyphs stripped first) — first-N-chars
 *   matching FAILS on tool-block / artifact openers. Cache the uuid on the
 *   element (`data-cc-uuid`).
 * - seek: direct text-match against rendered nodes →
 *   proportional scroll (`msgIndex/total × (scrollHeight−clientHeight)`; the
 *   virtualizer keeps a proportional full-height scrollbar) → retry the match
 *   every 300 ms ≤ 16 tries → smooth scrollIntoView.
 */

import type { ConversationStore, IndexedMessage } from "./conversation-store";
import type { Selectors } from "./selectors";
import { probeSamples, stripForMatch } from "@/shared/text";

const SEEK_RETRY_MS = 300;
const SEEK_MAX_TRIES = 16;

export type JumpResult = "direct" | "seeking" | "not-found";

export class DomMatcher {
  readonly #store: ConversationStore;
  readonly #selectors: Selectors;
  /** Only one seek runs at a time — a new jump cancels the previous retry loop. */
  #seekTimer: number | null = null;

  constructor(opts: { store: ConversationStore; selectors: Selectors }) {
    this.#store = opts.store;
    this.#selectors = opts.selectors;
  }

  /**
   * Resolve a rendered message element to its API uuid, caching the result on
   * the element. Returns null when no confident match exists (never guesses).
   */
  uuidForElement(el: HTMLElement, sender: "human" | "assistant" = "assistant"): string | null {
    const cached = el.dataset["ccUuid"];
    if (cached) return cached;

    const rendered = el.innerText;
    const probes = probeSamples(rendered).filter((s) => s.length >= 15);
    if (probes.length === 0) return null;

    const index = this.#store.current();
    if (!index) return null;

    const match = index.messages.find((m) => {
      if (m.sender !== sender) return false;
      const hay = stripForMatch(m.text);
      return probes.some((p) => hay.includes(p));
    });
    if (!match) return null;

    el.dataset["ccUuid"] = match.uuid;
    return match.uuid;
  }

  /** Find the rendered element for a message uuid, if it is currently in the DOM. */
  elementForUuid(uuid: string): HTMLElement | null {
    const index = this.#store.current();
    const message = index?.messages.find((m) => m.uuid === uuid);
    if (!message) return null;
    const name = message.sender === "human" ? "userMessage" : "assistantMessage";
    for (const el of this.#selectors.queryAll<HTMLElement>(name)) {
      if (!this.#selectors.closest("messageBlock", el)) continue;
      if (this.uuidForElement(el, message.sender) === uuid) return el;
    }
    return null;
  }

  /**
   * Jump to a message (optionally to a specific heading inside it). Returns
   * "direct" when the target was already rendered, "seeking" when a
   * proportional-scroll retry loop was started, "not-found" otherwise.
   */
  jumpTo(uuid: string, opts: { headingText?: string } = {}): JumpResult {
    this.#cancelSeek();

    const index = this.#store.current();
    const message = index?.messages.find((m) => m.uuid === uuid);
    if (!index || !message) return "not-found";

    const el = this.#matchRendered(message, opts.headingText);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return "direct";
    }

    // Proportional scroll toward the message, then retry the text match while
    // the virtualizer renders the neighborhood.
    const scroller = this.findScroller();
    const frac = Math.max(0, Math.min(1, message.index / Math.max(1, index.messages.length - 1)));
    scroller.scrollTo({ top: frac * (scroller.scrollHeight - scroller.clientHeight) });

    let tries = 0;
    this.#seekTimer = window.setInterval(() => {
      tries++;
      const found = this.#matchRendered(message, opts.headingText);
      if (found) {
        this.#cancelSeek();
        found.scrollIntoView({ behavior: "smooth", block: "start" });
      } else if (tries >= SEEK_MAX_TRIES) {
        this.#cancelSeek();
      }
    }, SEEK_RETRY_MS);
    return "seeking";
  }

  /**
   * The scrollable conversation container (walk up from a message block).
   * Public: this is the ONE scroller-resolution fact — scroll-lock
   * consumes it via ctx.matcher instead of re-deriving it.
   */
  findScroller(): Element {
    let el: Element | null = this.#selectors.query("messageBlock");
    while (el && el.scrollHeight <= el.clientHeight + 10) el = el.parentElement;
    return el ?? document.scrollingElement ?? document.documentElement;
  }

  /** Direct text match against rendered nodes. */
  #matchRendered(message: IndexedMessage, headingText?: string): HTMLElement | null {
    const key = stripForMatch(message.text).toLowerCase().slice(0, 50);
    if (!key) return null;
    const name = message.sender === "human" ? "userMessage" : "assistantMessage";
    for (const el of this.#selectors.queryAll<HTMLElement>(name)) {
      if (!this.#selectors.closest("messageBlock", el)) continue;
      const body = stripForMatch(el.textContent ?? "").toLowerCase();
      if (!body.includes(key)) continue;
      if (headingText) {
        const headKey = stripForMatch(headingText).toLowerCase().slice(0, 40);
        for (const h of el.querySelectorAll<HTMLElement>("h1,h2,h3,h4")) {
          if (stripForMatch(h.textContent ?? "").toLowerCase().includes(headKey)) return h;
        }
      }
      return el;
    }
    return null;
  }

  #cancelSeek(): void {
    if (this.#seekTimer !== null) {
      window.clearInterval(this.#seekTimer);
      this.#seekTimer = null;
    }
  }
}
