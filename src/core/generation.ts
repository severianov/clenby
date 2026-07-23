/**
 * The ONE streaming / working-state detector.
 *
 * Primary signal: the stop-generation button (DOM-growth heuristics alone
 * false-positive when the virtualizer re-renders, e.g. during outline
 * jumps). Fallback: growth of the LAST message block only, requiring ≥2
 * consecutive growth ticks before declaring `generation:start`, ending after
 * 2.5 s without growth. Once the stop button has been observed on this page,
 * its absence is trusted as "idle" and the growth heuristic only feeds the
 * tok/s rate (`generation:tick`).
 */

import type { EventBus } from "./event-bus";
import type { Selectors } from "./selectors";

const POLL_MS = 500;
const GROWTH_MIN_DELTA = 5;
const GROWTH_TICKS_TO_START = 2;
const GROWTH_END_SILENCE_MS = 2500;

export class GenerationDetector {
  readonly #bus: EventBus;
  readonly #selectors: Selectors;

  #timer: number | null = null;
  #working = false;
  #stopButtonEverSeen = false;
  #lastLen = 0;
  #lastGrowthAt = 0;
  #consecutiveGrowthTicks = 0;

  constructor(opts: { bus: EventBus; selectors: Selectors }) {
    this.#bus = opts.bus;
    this.#selectors = opts.selectors;
  }

  get working(): boolean {
    return this.#working;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#lastLen = this.#lastBlockLength();
    this.#timer = window.setInterval(() => this.#tick(), POLL_MS);
  }

  stop(): void {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #tick(): void {
    const now = Date.now();
    const stopVisible = this.#selectors.query("stopButton") !== null;
    if (stopVisible) this.#stopButtonEverSeen = true;

    // ---- growth measurement (last message only) ----
    const len = this.#lastBlockLength();
    const delta = len - this.#lastLen;
    const growing = delta > GROWTH_MIN_DELTA;
    if (growing) {
      this.#lastGrowthAt = now;
      this.#consecutiveGrowthTicks++;
    } else if (delta < 0) {
      // Re-render / conversation switch — reset the heuristic entirely.
      this.#consecutiveGrowthTicks = 0;
    } else {
      this.#consecutiveGrowthTicks = 0;
    }
    this.#lastLen = len;

    // ---- state decision ----
    let working: boolean;
    if (stopVisible) {
      working = true;
    } else if (this.#stopButtonEverSeen) {
      // The stop-button selector is known-good on this page: absence = idle.
      working = false;
    } else {
      // Selector never matched (may have drifted) — growth fallback.
      working = this.#working
        ? now - this.#lastGrowthAt <= GROWTH_END_SILENCE_MS
        : this.#consecutiveGrowthTicks >= GROWTH_TICKS_TO_START;
    }

    if (working && !this.#working) {
      this.#working = true;
      this.#bus.emit("generation:start", {});
    } else if (!working && this.#working) {
      this.#working = false;
      this.#bus.emit("generation:end", {});
    }

    if (this.#working && growing) {
      this.#bus.emit("generation:tick", { charsDelta: delta });
    }
  }

  /** Character length of the LAST rendered message block (growth probe). */
  #lastBlockLength(): number {
    const blocks = this.#selectors.queryAll("messageBlock");
    const last = blocks[blocks.length - 1];
    return last ? (last.textContent ?? "").length : 0;
  }
}
