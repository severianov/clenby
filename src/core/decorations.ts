/**
 * Owner of the shared per-message real estate: the
 * left gutter (fold button, pin) and the meta area at the bottom of answers.
 * Features REQUEST slots; they never create their own containers in claude's
 * DOM — two features can never fight over the same element.
 *
 * Thread-only guard (folding landmine): message-like markup also renders in
 * the artifact/document viewer. Slots are only handed out inside
 * `[data-test-render-count]`, and companion.css additionally CSS-hides any
 * `.cc-gutter` / `.cc-meta-area` that escapes the thread.
 */

import type { Selectors } from "./selectors";
import { Z } from "./zindex";

const GUTTER_CLASS = "cc-gutter";
const META_CLASS = "cc-meta-area";
const FLASH_CLASS = "cc-probe-flash";
/** Probe results can be huge — outline at most this many elements. */
const FLASH_MAX_ELEMENTS = 80;
const FLASH_MS = 2400;

export class DecorationsService {
  readonly #selectors: Selectors;

  /** Elements currently carrying the probe-flash outline (repair flow). */
  #flashed: Element[] = [];
  #flashTimer: number | null = null;

  constructor(opts: { selectors: Selectors }) {
    this.#selectors = opts.selectors;
  }

  /**
   * Flash-outline a set of matched elements so the user can SEE what a
   * probed selector grabbed (self-healing repair flow). Purely additive — a
   * class from companion.css (reduced-motion aware) added then removed;
   * re-flashing clears the previous set first. Callers register
   * {@link clearFlash} with `ctx.onCleanup` so an unmount never leaves
   * outlines behind.
   */
  flash(elements: readonly Element[], ms: number = FLASH_MS): void {
    this.clearFlash();
    const list = elements.slice(0, FLASH_MAX_ELEMENTS);
    for (const el of list) el.classList.add(FLASH_CLASS);
    this.#flashed = list;
    this.#flashTimer = window.setTimeout(() => this.clearFlash(), ms);
  }

  /** Remove any active probe-flash outlines immediately. Idempotent. */
  clearFlash(): void {
    if (this.#flashTimer !== null) {
      window.clearTimeout(this.#flashTimer);
      this.#flashTimer = null;
    }
    for (const el of this.#flashed) el.classList.remove(FLASH_CLASS);
    this.#flashed = [];
  }

  /**
   * A slot in the message's left gutter for `featureId` (created on first
   * request; returned again on repeat requests). Slots stack vertically in
   * request order — fold first, pin under it. Returns null outside the
   * conversation thread.
   */
  gutterSlot(messageEl: HTMLElement, featureId: string): HTMLElement | null {
    if (!this.#inThread(messageEl)) return null;
    const gutter = this.#ensureContainer(messageEl, GUTTER_CLASS);
    return this.#ensureSlot(gutter, featureId);
  }

  /**
   * A slot in the message's meta line area (bottom of the answer body).
   * Returns null outside the conversation thread.
   */
  metaSlot(messageEl: HTMLElement, featureId: string): HTMLElement | null {
    if (!this.#inThread(messageEl)) return null;
    const meta = this.#ensureContainer(messageEl, META_CLASS, "append");
    return this.#ensureSlot(meta, featureId);
  }

  #inThread(el: HTMLElement): boolean {
    return this.#selectors.closest("messageBlock", el) !== null;
  }

  #ensureContainer(
    messageEl: HTMLElement,
    className: string,
    position: "prepend" | "append" = "prepend",
  ): HTMLElement {
    let container = messageEl.querySelector<HTMLElement>(`:scope > .${className}`);
    if (!container) {
      if (getComputedStyle(messageEl).position === "static") {
        // Geometry-only inline style — required so the gutter rail can anchor.
        messageEl.style.position = "relative";
      }
      container = document.createElement("div");
      container.className = className;
      container.dataset["ccOwner"] = "core-decorations";
      if (className === GUTTER_CLASS) container.style.zIndex = String(Z.gutter);
      if (className === META_CLASS) container.style.zIndex = String(Z.meta);
      if (position === "prepend") messageEl.prepend(container);
      else messageEl.append(container);
    }
    return container;
  }

  #ensureSlot(container: HTMLElement, featureId: string): HTMLElement {
    let slot = container.querySelector<HTMLElement>(`:scope > [data-cc-owner="${featureId}"]`);
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "cc-slot";
      slot.dataset["ccOwner"] = featureId;
      container.append(slot);
    }
    return slot;
  }
}
