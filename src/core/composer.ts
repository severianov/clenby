/**
 * The ONE composer service: find the ProseMirror
 * contenteditable, read the draft, insert text, emit draft-change events.
 *
 * `insertText` uses `document.execCommand("insertText")` — deprecated but the
 * only way to insert into ProseMirror so React/PM state stays consistent
 * (verified in the quote-to-reply + console-relay flows).
 *
 * The status bar anchors to the composer's rounded container: walk up from the contenteditable to the first ancestor with a
 * `rounded` class — fixed-position anchoring to the contenteditable is NOT
 * reliable.
 */

import type { EventBus } from "./event-bus";
import type { Selectors } from "./selectors";
import { wordCount } from "@/shared/text";

const DRAFT_POLL_MS = 600;

export class ComposerService {
  readonly #bus: EventBus;
  readonly #selectors: Selectors;
  #timer: number | null = null;
  #lastDraft = "";

  constructor(opts: { bus: EventBus; selectors: Selectors }) {
    this.#bus = opts.bus;
    this.#selectors = opts.selectors;
  }

  /**
   * The composer contenteditable, or null when not on a chat view.
   *
   * GEOMETRY-BASED picker (a plain contenteditable query also matches
   * artifact editors): among ALL contenteditables,
   * keep those wider than 200px whose bottom edge sits in the lower 55% of
   * the viewport, and take the BOTTOM-MOST. A selector-only, first-in-DOM
   * pick can target an open artifact code editor instead of the chat
   * composer — breaking console-relay insertText and undo-send draft reads.
   * Falls back to the plain selector when no candidate passes the filter
   * (e.g. composer off-screen during layout).
   */
  find(): HTMLElement | null {
    const candidates = this.#selectors
      .queryAll<HTMLElement>("contentEditable")
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.bottom > window.innerHeight * 0.45;
      })
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return candidates[0] ?? this.#selectors.query("composerInput");
  }

  /**
   * The composer's rounded container — the status-bar anchor (lesson 7).
   * Walks up from the contenteditable to the first ancestor whose class list
   * contains a `rounded` utility.
   */
  container(): HTMLElement | null {
    let el: HTMLElement | null = this.find();
    while (el && el !== document.body) {
      const cls = typeof el.className === "string" ? el.className : "";
      if (/(^|\s)[^ ]*rounded/.test(cls)) return el;
      el = el.parentElement;
    }
    return null;
  }

  /** Current draft text (plain text, untrimmed except trailing newline). */
  readDraft(): string {
    const el = this.find();
    if (!el) return "";
    return (el.innerText ?? "").replace(/\n$/, "");
  }

  /**
   * Insert text at the caret (focusing the composer first). Returns false when
   * the composer is missing or the insertion failed — callers degrade quietly
   *, never block claude.ai.
   */
  insertText(text: string): boolean {
    const el = this.find();
    if (!el) return false;
    try {
      el.focus();
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- required for ProseMirror
      return document.execCommand("insertText", false, text);
    } catch (err) {
      console.debug("[cc] composer insertText failed", err);
      return false;
    }
  }

  /** Start the draft-change poll (emits `composer:draft-changed`). */
  start(): void {
    if (this.#timer !== null) return;
    this.#lastDraft = this.readDraft();
    this.#timer = window.setInterval(() => {
      const text = this.readDraft();
      if (text === this.#lastDraft) return;
      this.#lastDraft = text;
      this.#bus.emit("composer:draft-changed", { text, words: wordCount(text) });
    }, DRAFT_POLL_MS);
  }

  stop(): void {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
