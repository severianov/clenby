/**
 * The feature lifecycle contract — the most important
 * module in the codebase.
 *
 * Every classic bug class (stale handlers after re-injection, two timers
 * fighting over the status bar, features mutating each other's DOM) came from
 * features owning their own global resources. This module inverts that:
 * features NEVER touch global timer/observer/listener APIs. They receive a
 * {@link FeatureContext} whose managed methods register every resource, and the
 * runtime disposes all of them at unmount. A feature that follows the contract
 * cannot leak.
 */

import type { CompanionEvents, EventBus } from "./event-bus";
import type { ClaudeApi } from "@/api/client";
import type { FeatureOverrides } from "./overrides";
import type { ScopedStorage } from "./storage";
import type { ConversationStore } from "./conversation-store";
import type { DomMatcher } from "./dom-matcher";
import type { ComposerService } from "./composer";
import type { Selectors } from "./selectors";
import type { DecorationsService } from "./decorations";

export type FeatureScope =
  | "session" // mounted once per page load (theme engine, header cluster, done-ping)
  | "conversation"; // unmounted + remounted by the runtime on every conversation switch

export interface FeatureModule {
  /** kebab-case, used for data-cc-owner + logging. */
  readonly id: string;
  readonly tier: 1 | 2 | 3;
  readonly scope: FeatureScope;
  /**
   * Create UI, subscribe, start observers — ONLY via ctx. Must be
   * idempotent-safe: the runtime guarantees unmount() completed before any
   * remount.
   */
  mount(ctx: FeatureContext): void | Promise<void>;
  /**
   * Optional feature-specific teardown (e.g. flush a pending save). Runs
   * BEFORE the runtime disposes ctx resources. Must not throw.
   */
  unmount?(): void;
}

/** The read-only core-service handles a feature receives. */
export interface FeatureServices {
  readonly bus: EventBus;
  readonly api: ClaudeApi;
  /** Pre-scoped: `storage.conv` is bound to the current conversation id. */
  readonly storage: ScopedStorage;
  readonly conversation: ConversationStore;
  readonly matcher: DomMatcher;
  readonly composer: ComposerService;
  readonly selectors: Selectors;
  readonly decorations: DecorationsService;
  /** The self-healing override layer's feature slice: health ledgers +
   *  validated read/write/reset/export/import of overrides
   *  (core/overrides.ts). Writes cannot bypass validation. */
  readonly overrides: FeatureOverrides;
  /** #cc-root — the ONLY place features may append top-level UI. */
  readonly root: HTMLElement;
}

export interface FeatureContext extends FeatureServices {
  // ---- managed resources: every one is auto-disposed at unmount ----
  setInterval(fn: () => void, ms: number): void;
  setTimeout(fn: () => void, ms: number): void;
  observe(target: Node, cb: MutationCallback, opts: MutationObserverInit): void;
  listen<K extends keyof GlobalEventHandlersEventMap>(
    target: EventTarget,
    type: K,
    handler: (ev: GlobalEventHandlersEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  listen(
    target: EventTarget,
    type: string,
    handler: (ev: Event) => void,
    opts?: AddEventListenerOptions,
  ): void;
  on<E extends keyof CompanionEvents>(
    event: E,
    handler: (payload: CompanionEvents[E]) => void,
  ): void;
  /** For anything else (revoke object URLs, remove marks, …). */
  onCleanup(fn: () => void): void;
  /** Aborted at unmount — pass to fetch / await guards. */
  readonly signal: AbortSignal;
}

/**
 * The concrete resource ledger behind a FeatureContext. The runtime creates
 * one per mount and calls {@link dispose} at unmount; disposal is idempotent.
 */
export class ManagedResources {
  #intervals: number[] = [];
  #timeouts: number[] = [];
  #observers: MutationObserver[] = [];
  #listeners: Array<{
    target: EventTarget;
    type: string;
    handler: EventListener;
    opts?: AddEventListenerOptions;
  }> = [];
  #cleanups: Array<() => void> = [];
  #abort = new AbortController();
  #disposed = false;

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  setInterval(fn: () => void, ms: number): void {
    if (this.#disposed) return;
    this.#intervals.push(window.setInterval(fn, ms));
  }

  setTimeout(fn: () => void, ms: number): void {
    if (this.#disposed) return;
    this.#timeouts.push(window.setTimeout(fn, ms));
  }

  observe(target: Node, cb: MutationCallback, opts: MutationObserverInit): void {
    if (this.#disposed) return;
    const observer = new MutationObserver(cb);
    observer.observe(target, opts);
    this.#observers.push(observer);
  }

  listen(
    target: EventTarget,
    type: string,
    handler: (ev: Event) => void,
    opts?: AddEventListenerOptions,
  ): void {
    if (this.#disposed) return;
    const h = handler as EventListener;
    target.addEventListener(type, h, opts);
    this.#listeners.push({ target, type, handler: h, ...(opts ? { opts } : {}) });
  }

  onCleanup(fn: () => void): void {
    if (this.#disposed) {
      // Late registration after disposal: run immediately so nothing leaks.
      runSafe(fn);
      return;
    }
    this.#cleanups.push(fn);
  }

  /**
   * Dispose everything, in the inverse order of acquisition where it matters:
   * feature cleanups run first (they may still need live listeners), then all
   * platform resources are torn down, then the abort signal fires.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    for (const fn of [...this.#cleanups].reverse()) runSafe(fn);
    this.#cleanups = [];

    for (const id of this.#intervals) window.clearInterval(id);
    this.#intervals = [];
    for (const id of this.#timeouts) window.clearTimeout(id);
    this.#timeouts = [];
    for (const o of this.#observers) o.disconnect();
    this.#observers = [];
    for (const l of this.#listeners) {
      // Per-item guard: targets can be foreign windows/documents (mini-window
      // PiP/popups) that are already closed — Firefox throws "can't access
      // dead object" there, and one bad target must not skip the rest of the
      // teardown or the abort below.
      try {
        l.target.removeEventListener(l.type, l.handler, l.opts);
      } catch {
        // dead foreign target — nothing left to remove
      }
    }
    this.#listeners = [];

    this.#abort.abort();
  }
}

function runSafe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error("[cc] cleanup threw", err);
  }
}

/**
 * Bind core services + a resource ledger into the context object a feature's
 * `mount` receives. Bus subscriptions made through `ctx.on` are registered as
 * cleanups so they auto-dispose with everything else.
 */
export function createFeatureContext(
  services: FeatureServices,
  resources: ManagedResources,
): FeatureContext {
  return {
    ...services,

    setInterval: (fn, ms) => resources.setInterval(fn, ms),
    setTimeout: (fn, ms) => resources.setTimeout(fn, ms),
    observe: (target, cb, opts) => resources.observe(target, cb, opts),
    listen: (
      target: EventTarget,
      type: string,
      handler: (ev: Event) => void,
      opts?: AddEventListenerOptions,
    ) => resources.listen(target, type, handler, opts),
    on: <E extends keyof CompanionEvents>(
      event: E,
      handler: (payload: CompanionEvents[E]) => void,
    ) => {
      resources.onCleanup(services.bus.on(event, handler));
    },
    onCleanup: (fn) => resources.onCleanup(fn),
    get signal() {
      return resources.signal;
    },
  };
}
