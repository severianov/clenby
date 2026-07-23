/**
 * Typed pub/sub. Exactly one detector per fact:
 * core services emit, features subscribe (always via ctx.on, which auto-
 * disposes). Extend {@link CompanionEvents} in this file only.
 */

import type { SelectorName } from "./selectors";
import type { BridgeSession } from "@/shared/bridge-protocol";
import type { HandoffHandle, HandoffScope } from "@/shared/handoff";

export interface CompanionEvents {
  "nav:conversation-changed": { convId: string | null };
  "conversation:indexed": { convId: string; messageCount: number };
  "conversation:updated": { convId: string };
  "generation:start": Record<string, never>;
  "generation:tick": { charsDelta: number };
  "generation:end": Record<string, never>;
  "composer:draft-changed": { text: string; words: number };
  "theme:applied": { themeId: string; mode: "light" | "dark" };
  "api:degraded": { endpoint: string };
  /**
   * A selector anchor degraded — emitted by the override layer's health
   * ledger (core/overrides.ts) on the TRANSITION into
   * `fallback` (shipped primary dead, running on a fallback — borrowed time)
   * or `broken` (nothing matches). Consumers: the selector-health feature
   * (break-alert banner + dashboard refresh) and the gear menu's degraded
   * count.
   */
  "selector:degraded": { name: SelectorName; state: "fallback" | "broken" };
  /**
   * Toggle the Selector Health panel (gear-menu button + palette action) —
   * the self-healing layer's dashboard + override editor. Session-scoped
   * subscriber (selector-health), so the emit always lands.
   */
  "ui:selector-health-toggle": Record<string, never>;
  "fold:all": { folded: boolean };
  /** Header cluster opened the 📝 popover — notes mounts into `container`. */
  "ui:notes-open": { container: HTMLElement };
  /** Header cluster opened the gear menu — export mounts into `container`. */
  "ui:export-open": { container: HTMLElement };
  /** Toggle the command palette (header-cluster button; the palette also
   *  listens for Ctrl/Cmd+Shift+K itself). */
  "ui:palette-toggle": Record<string, never>;
  /** Toggle the Conversation Atlas overlay. DORMANT: the atlas feature is
   *  deactivated (kept in src/features/atlas, unregistered) — nothing emits
   *  or subscribes until it is re-added to the registry and its gear/palette
   *  entries are restored. The event stays defined for that revival. */
  "ui:atlas-toggle": Record<string, never>;
  /**
   * TOGGLE an answer's card in the always-on-top mini-window (the single
   * Document Picture-in-Picture window — floats over every tab and app
   * window; on Firefox, which has no Document PiP, each answer degrades to
   * its own small popup window). With a `uuid` (answer-toolbar) the
   * mini-window feature adds/removes exactly that answer's card; without one
   * (palette action) it acts on the answer nearest the viewport center.
   * Session-scoped subscriber — the pinned window survives conversation
   * switches; the emit must ride the CLICK synchronously (requestWindow
   * consumes the user gesture).
   */
  "ui:mini-window-popout": { uuid?: string };
  /**
   * The popped-out answer set changed (the mini-window feature is the ONE
   * producer): emitted on every card add/remove/window-close with the FULL
   * uuid list, and re-emitted on "conversation:indexed" so per-conversation
   * consumers that (re)mount later still sync up. The answer-toolbar
   * subscribes to paint each rendered answer's pop-out button active/
   * inactive — features never import each other.
   */
  "mini-window:changed": { uuids: string[] };
  /** Toggle a pin on an answer by uuid — emitted by the answer-toolbar's
   *  Pin action and the outline's Pinned-group ✕. The pins feature owns the
   *  toggle/persist path — features never import each other. */
  "ui:pin-toggle": { uuid: string };
  /**
   * The pinned set changed (the pins feature is the ONE producer): emitted
   * once after the per-conversation set loads at mount and again on every
   * toggle, always carrying the FULL uuid list. The answer-toolbar subscribes
   * to paint each rendered answer's Pin button active/inactive — features
   * never import each other, and consumers never re-read storage here (the
   * async write may not have settled yet).
   */
  "pins:changed": { pinned: string[] };
  /** Append a text snippet to this conversation's notes (answer-toolbar's
   *  "add to note" action). The notes feature files it as a new note and
   *  refreshes an open list view. */
  "ui:note-append": { text: string };
  /**
   * Reading-position fact from scroll-lock (the ONE producer): true
   * while the user has scrolled away from the bottom of the thread (native
   * auto-follow is being suppressed during generation). Published for any
   * reading-UX consumer; currently informational only.
   */
  "reading:away-changed": { away: boolean };
  /**
   * A highlight record was removed by a NON-owning surface (the outline's
   * Marks-tab ✕). The highlights feature drops it from its in-memory records
   * (so the re-apply loop can never restore it) and unwraps every remaining
   * `mark.cc-hl` segment with this id. Carries the id — never re-read from
   * storage here, the async write may not have settled yet.
   */
  "highlights:removed": { convId: string; id: string };
  /**
   * Toggle the find-in-conversation bar (gear-menu button + palette action;
   * the bar also listens for Ctrl/Cmd+Shift+F itself — never the browser's
   * native Ctrl+F). Searches the API-indexed conversation, so it sees every
   * message, not just the rendered/virtualized window. Conversation-scoped
   * subscriber; outside a chat the emit is a quiet no-op.
   */
  "ui:find-toggle": Record<string, never>;
  /**
   * The Claude Code bridge roster/binding changed — the claude-code-bridge
   * feature is the ONE producer. Emitted on every roster update from the
   * background and on every binding change, always carrying the full session
   * list + the currently bound sessionId + whether pairing is set up.
   * Consumer: the answer-toolbar's "Send to Claude Code" action (light/inert +
   * the read-only target line) — features never import each other.
   */
  "bridge:changed": {
    sessions: BridgeSession[];
    boundSessionId: string | null;
    paired: boolean;
  };
  /**
   * The answer-toolbar's "Send to Claude Code" action fires this with the
   * chosen handle + scope (+ the answer uuid, or the captured raw text for a
   * selection). The claude-code-bridge feature assembles the handoff and pushes
   * it to the bound session, then reports back via "bridge:send-result".
   */
  "bridge:send": {
    handle: HandoffHandle;
    scope: HandoffScope;
    uuid?: string;
    selectionText?: string;
  };
  /** Result of the most recent "bridge:send" (the claude-code-bridge feature is
   *  the producer): delivered after the bridge acks, or a calm failure reason.
   *  The answer-toolbar reflects it on the pressed button. */
  "bridge:send-result": { ok: boolean; reason?: string };
}

export type CompanionEvent = keyof CompanionEvents;
export type EventHandler<E extends CompanionEvent> = (payload: CompanionEvents[E]) => void;

export class EventBus {
  // Handlers are stored payload-erased; the public on/off/emit signatures are
  // the sole (typed) boundary, so the internal casts are variance plumbing,
  // never a hole a caller can reach.
  #handlers = new Map<CompanionEvent, Set<(payload: unknown) => void>>();

  /** Subscribe. Returns an unsubscribe function (also removable via {@link off}). */
  on<E extends CompanionEvent>(event: E, handler: EventHandler<E>): () => void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    set.add(handler as (payload: unknown) => void);
    return () => this.off(event, handler);
  }

  off<E extends CompanionEvent>(event: E, handler: EventHandler<E>): void {
    this.#handlers.get(event)?.delete(handler as (payload: unknown) => void);
  }

  /**
   * Emit synchronously. A throwing handler is caught and logged — one bad
   * subscriber can never break the emitter or the other subscribers.
   */
  emit<E extends CompanionEvent>(event: E, payload: CompanionEvents[E]): void {
    const set = this.#handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[cc] handler for "${event}" threw`, err);
      }
    }
  }

  /** Test/teardown helper — drop every subscription. */
  clear(): void {
    this.#handlers.clear();
  }
}
