/**
 * The ONE conversation fetch + index cache.
 *
 * Features never call `api.getConversation` directly — they call
 * `ctx.conversation.ensure()` / read `.current()` and subscribe to
 * `conversation:indexed` / `conversation:updated` on the bus.
 *
 * - In-flight dedupe: one fetch per conversation id at a time.
 * - Refresh policy: invalidated on conversation switch; refetched after
 *   `generation:end` (→ emits `conversation:updated`).
 * - Degradation: on API failure (`api:degraded`) the store flips to the
 *   DOM-index fallback — scan rendered nodes.
 *   Features read the store either way; they never branch on API health.
 *
 * Attachment-aware labels for text-less messages; `(empty message)`
 * placeholder.
 */

import type { ClaudeApi } from "@/api/client";
import type { EventBus } from "./event-bus";
import type { NavigationWatcher } from "./navigation";
import type { Selectors } from "./selectors";
import { messageText } from "@/api/types";

export interface IndexedMessage {
  /** API uuid, or `dom-<n>` for DOM-fallback entries. */
  uuid: string;
  sender: "human" | "assistant";
  /** Display/index text — attachment-aware label when the message has no text. */
  text: string;
  /** ISO timestamp; null when the source is the DOM fallback. */
  createdAt: string | null;
  /** Position in the conversation (0-based, over all senders). */
  index: number;
}

export interface ConversationIndex {
  convId: string;
  name: string;
  model: string | null;
  messages: IndexedMessage[];
  /** "api" = full index; "dom" = partial (virtualized) fallback index. */
  source: "api" | "dom";
  fetchedAt: number;
}

export class ConversationStore {
  readonly #api: ClaudeApi;
  readonly #bus: EventBus;
  readonly #nav: NavigationWatcher;
  readonly #selectors: Selectors;

  #current: ConversationIndex | null = null;
  #inflight: Promise<ConversationIndex | null> | null = null;
  #inflightConvId: string | null = null;
  #degraded = false;
  #unsubs: Array<() => void> = [];

  constructor(opts: {
    api: ClaudeApi;
    bus: EventBus;
    navigation: NavigationWatcher;
    selectors: Selectors;
  }) {
    this.#api = opts.api;
    this.#bus = opts.bus;
    this.#nav = opts.navigation;
    this.#selectors = opts.selectors;
  }

  /** Wire bus subscriptions. Called once by the runtime at boot. */
  start(): void {
    this.#unsubs.push(
      this.#bus.on("nav:conversation-changed", ({ convId }) => {
        this.#current = null;
        if (convId) {
          this.ensure().catch((err) => {
            console.warn("[cc] conversation index fetch failed (contained)", err);
          });
        }
      }),
      this.#bus.on("generation:end", () => {
        const convId = this.#nav.currentConvId;
        if (!convId) return;
        this.ensure(true)
          .then((index) => {
            if (index) this.#bus.emit("conversation:updated", { convId: index.convId });
          })
          .catch((err) => {
            console.warn("[cc] post-generation index refresh failed (contained)", err);
          });
      }),
      this.#bus.on("api:degraded", () => {
        this.#degraded = true;
      }),
    );
  }

  stop(): void {
    for (const u of this.#unsubs) u();
    this.#unsubs = [];
  }

  /** Latest index snapshot for the current conversation, or null. */
  current(): ConversationIndex | null {
    const convId = this.#nav.currentConvId;
    if (!convId || this.#current?.convId !== convId) return null;
    return this.#current;
  }

  /** True while the store serves DOM-fallback (partial) indexes. */
  get degraded(): boolean {
    return this.#degraded;
  }

  /**
   * Ensure an index exists for the current conversation. Deduped: concurrent
   * callers share one fetch. `force` refetches even when cached.
   */
  ensure(force = false): Promise<ConversationIndex | null> {
    const convId = this.#nav.currentConvId;
    if (!convId) return Promise.resolve(null);

    if (!force && this.#current?.convId === convId) {
      return Promise.resolve(this.#current);
    }
    if (this.#inflight && this.#inflightConvId === convId && !force) {
      return this.#inflight;
    }

    this.#inflightConvId = convId;
    this.#inflight = this.#fetch(convId).finally(() => {
      this.#inflight = null;
      this.#inflightConvId = null;
    });
    return this.#inflight;
  }

  async #fetch(convId: string): Promise<ConversationIndex | null> {
    const result = await this.#api.getConversation(convId);

    // The user may have switched conversations while the fetch ran.
    if (this.#nav.currentConvId !== convId) return null;

    let index: ConversationIndex;
    if (result.ok) {
      this.#degraded = false;
      index = {
        convId,
        name: result.data.name || "(untitled)",
        model: result.data.model,
        source: "api",
        fetchedAt: Date.now(),
        messages: result.data.chat_messages.map((m, i) => {
          let text = messageText(m);
          const nAtt = (m.files?.length ?? 0) + (m.attachments?.length ?? 0);
          if (!text && nAtt > 0) text = `📎 ${nAtt} attachment${nAtt === 1 ? "" : "s"}`;
          else if (!text) text = "(empty message)";
          return {
            uuid: m.uuid,
            sender: m.sender,
            text,
            createdAt: m.created_at,
            index: i,
          };
        }),
      };
    } else if (result.error === "aborted") {
      return null;
    } else {
      // API down or shape drifted — DOM fallback keeps features alive with a
      // partial index (rendered messages only; virtualization applies).
      index = this.#indexFromDom(convId);
    }

    this.#current = index;
    this.#bus.emit("conversation:indexed", { convId, messageCount: index.messages.length });
    return index;
  }

  #indexFromDom(convId: string): ConversationIndex {
    const messages: IndexedMessage[] = [];
    const blocks = this.#selectors.queryAll("messageBlock");
    let i = 0;
    for (const block of blocks) {
      const user = this.#selectors.query("userMessage", block);
      const assistant = this.#selectors.query("assistantMessage", block);
      for (const [el, sender] of [
        [user, "human"],
        [assistant, "assistant"],
      ] as const) {
        if (!el) continue;
        const text = (el.textContent ?? "").trim() || "(empty message)";
        messages.push({
          uuid: `dom-${i}`,
          sender,
          text,
          createdAt: null,
          index: i,
        });
        i++;
      }
    }
    return {
      convId,
      name: document.title || "(untitled)",
      model: null,
      messages,
      source: "dom",
      fetchedAt: Date.now(),
    };
  }
}
