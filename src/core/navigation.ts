/**
 * The ONE SPA-nav watcher. claude.ai is a SPA — there is
 * no reliable history event for every transition, so we poll `location.pathname`
 * every 600 ms and emit `nav:conversation-changed` when the conversation id
 * changes (including → null when leaving a chat).
 *
 * Core services may own raw timers (the timer ban applies to features only); this file
 * is the single owner of the nav poll.
 */

import type { EventBus } from "./event-bus";

const POLL_MS = 600;

/** Conversation ids are uuid-ish. */
const CONV_ID_RE = /^[0-9a-f-]{30,}$/;

/** Extract the conversation id from a claude.ai pathname, else null. */
export function convIdFromPathname(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  // /chat/<uuid> — the only shape we treat as a conversation page.
  if (parts.length >= 2 && parts[parts.length - 2] === "chat") {
    const last = parts[parts.length - 1];
    if (last && CONV_ID_RE.test(last)) return last;
  }
  return null;
}

export class NavigationWatcher {
  readonly #bus: EventBus;
  #timer: number | null = null;
  #convId: string | null = null;

  constructor(bus: EventBus) {
    this.#bus = bus;
    this.#convId = convIdFromPathname(location.pathname);
  }

  /** The conversation id the watcher last observed (null off-conversation). */
  get currentConvId(): string | null {
    return this.#convId;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = window.setInterval(() => this.#tick(), POLL_MS);
  }

  stop(): void {
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  #tick(): void {
    const next = convIdFromPathname(location.pathname);
    if (next === this.#convId) return;
    this.#convId = next;
    this.#bus.emit("nav:conversation-changed", { convId: next });
  }
}
