/**
 * Claude Code bridge — reverse-direction READ tools (spec §5).
 *
 * Code → web pull path. The MCP server (bridge/src/mcp-server.js) proxies these
 * six read methods to the extension over a `req` frame; the background relays
 * them to the last-focused claude.ai content script, which answers HERE from the
 * SAME live sources the outline / pins / notes features read — the conversation
 * index (API-backed `ConversationStore` / `ClaudeApi`) and conv-scoped
 * `storage.local`. Never the DOM, never a new selector, never a new permission.
 *
 * SECURITY (this passed a review and must stay passed — threat model §6):
 * - READ-ONLY. Nothing here mutates a store, writes storage, or sends a message.
 * - Content only. The output carries conversation CONTENT the user already sees;
 *   it never touches cookies / tokens / auth / `storage` auth (the API client
 *   uses the user's own same-origin session, exactly like every other feature).
 * - Bounded. List lengths and every text body are capped so a huge conversation
 *   can't return an unbounded blob to the model.
 *
 * The shaping functions are PURE (no browser API) so both the content script and
 * the unit tests import them freely; {@link runBridgeRead} is the thin
 * orchestrator that wires the live data sources into them.
 */

import type { ConversationIndex, IndexedMessage } from "@/core/conversation-store";
import type { ApiError, ApiResult, Conversation, ConversationStub } from "@/api/types";
import { messageText } from "@/api/types";
import { buildHandoffMarkdown, type BodyScope } from "@/shared/handoff";

// ---- caps (defense in depth; the bridge also clamps list limits) ----------
const DEFAULT_LIST = 20;
const MAX_LIST = 50;
/** Pool fetched before a title filter, so search sees more than one page. */
const SEARCH_FETCH_LIMIT = 100;
/** Hard ceiling on any returned array (pins / notes / highlights). */
const MAX_ITEMS = 500;
const MAX_PIN_TEXT = 400;
const MAX_NOTE_TEXT = 4000;
const MAX_HL_TEXT = 1000;
const MAX_SNIPPET = 200;
/** A whole conversation's markdown can be large — cap it sensibly. */
const MAX_MARKDOWN = 200_000;

// ---- output row shapes (spec §5 table) ------------------------------------
export interface RecentConversation {
  id: string;
  title: string;
  updated_at: string;
  url: string;
}
export interface SearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
}
export interface ConversationResult {
  id: string;
  title: string;
  url: string;
  markdown: string;
}
export interface Pin {
  id: string;
  text: string;
  message_id: string;
  created_at: string | null;
}
export interface Note {
  id: string;
  text: string;
  created_at: string | null;
}
export interface Highlight {
  text: string;
  message_id: string | null;
}

// ---- small pure helpers ----------------------------------------------------
export function chatUrl(id: string): string {
  return `https://claude.ai/chat/${id}`;
}

function clamp(v: number | undefined, max: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : dflt;
  return Math.max(1, Math.min(max, n));
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + " …[truncated]";
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---- pure shapers ----------------------------------------------------------

/**
 * Map a raw {@link Conversation} to a {@link ConversationIndex}, mirroring the
 * conversation-store's own API→index mapping (attachment-aware labels, empty
 * placeholder) so `get_conversation(id)` on an arbitrary id serializes exactly
 * like the current-conversation path the export/handoff features use.
 */
export function indexFromConversation(conv: Conversation): ConversationIndex {
  return {
    convId: conv.uuid,
    name: conv.name || "(untitled)",
    model: conv.model,
    source: "api",
    fetchedAt: Date.now(),
    messages: conv.chat_messages.map((m, i) => {
      let text = messageText(m);
      const nAtt = (m.files?.length ?? 0) + (m.attachments?.length ?? 0);
      if (!text && nAtt > 0) text = `📎 ${nAtt} attachment${nAtt === 1 ? "" : "s"}`;
      else if (!text) text = "(empty message)";
      return { uuid: m.uuid, sender: m.sender, text, createdAt: m.created_at, index: i };
    }),
  };
}

export function shapeRecent(
  stubs: ConversationStub[],
  limit: number | undefined,
): { conversations: RecentConversation[] } {
  const cap = clamp(limit, MAX_LIST, DEFAULT_LIST);
  return {
    conversations: stubs.slice(0, cap).map((s) => ({
      id: s.uuid,
      title: s.name || "(untitled)",
      updated_at: s.updated_at,
      url: chatUrl(s.uuid),
    })),
  };
}

export function shapeSearch(
  stubs: ConversationStub[],
  query: string,
  limit: number | undefined,
): { results: SearchResult[] } {
  const cap = clamp(limit, MAX_LIST, DEFAULT_LIST);
  const q = query.trim().toLowerCase();
  const results: SearchResult[] = [];
  for (const s of stubs) {
    if (results.length >= cap) break;
    const title = s.name || "(untitled)";
    // Stubs carry only the title — search titles (no per-message body fetch,
    // no DOM scrape). snippet mirrors the matched title.
    if (q && !title.toLowerCase().includes(q)) continue;
    results.push({ id: s.uuid, title, url: chatUrl(s.uuid), snippet: truncate(title, MAX_SNIPPET) });
  }
  return { results };
}

export function shapeConversation(index: ConversationIndex, scope: BodyScope): ConversationResult {
  return {
    id: index.convId,
    title: index.name,
    url: chatUrl(index.convId),
    markdown: truncate(buildHandoffMarkdown(index, scope), MAX_MARKDOWN),
  };
}

/**
 * Pins are stored as bare message uuids; text + timestamp come from the
 * conversation index (null when the index is unavailable).
 */
export function shapePins(pinned: string[], index: ConversationIndex | null): { pins: Pin[] } {
  const byId = new Map<string, IndexedMessage>();
  if (index) for (const m of index.messages) byId.set(m.uuid, m);
  const pins: Pin[] = [];
  for (const uuid of pinned) {
    if (pins.length >= MAX_ITEMS) break;
    if (typeof uuid !== "string" || !uuid) continue;
    const m = byId.get(uuid);
    pins.push({
      id: uuid,
      text: m ? truncate(m.text, MAX_PIN_TEXT) : "",
      message_id: uuid,
      created_at: m?.createdAt ?? null,
    });
  }
  return { pins };
}

/**
 * Notes live as a `NoteRecord[]` ({id,text,at,up}) — or, on legacy installs, a
 * single scratchpad string. Both shapes are accepted (todo items, which carry a
 * boolean `done`, are excluded — they are not notes).
 */
export function shapeNotes(raw: unknown): { notes: Note[] } {
  const notes: Note[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (notes.length >= MAX_ITEMS) break;
      if (!isRecordLike(v)) continue;
      if (typeof v["id"] !== "string" || typeof v["text"] !== "string") continue;
      if (typeof v["done"] === "boolean") continue; // a todo item, not a note
      notes.push({
        id: v["id"],
        text: truncate(v["text"], MAX_NOTE_TEXT),
        created_at: typeof v["at"] === "string" ? v["at"] : null,
      });
    }
  } else if (typeof raw === "string" && raw.trim()) {
    notes.push({ id: "notes", text: truncate(raw, MAX_NOTE_TEXT), created_at: null });
  }
  return { notes };
}

/** Highlights carry their own text + host message uuid (null before resolve). */
export function shapeHighlights(raw: unknown): { highlights: Highlight[] } {
  const highlights: Highlight[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (highlights.length >= MAX_ITEMS) break;
      if (!isRecordLike(v)) continue;
      if (typeof v["text"] !== "string") continue;
      highlights.push({
        text: truncate(v["text"], MAX_HL_TEXT),
        message_id: typeof v["uuid"] === "string" ? v["uuid"] : null,
      });
    }
  }
  return { highlights };
}

// ---- orchestrator ----------------------------------------------------------

/** The live data sources a read needs, injected so the orchestrator stays
 *  testable and the content script owns the browser-facing wiring. */
export interface BridgeReadDeps {
  /** List conversation stubs (the API client / conversation index source). */
  getConversations: (opts: { limit?: number }) => Promise<ApiResult<ConversationStub[]>>;
  /** Resolve a conversation index by id or the literal "current" (the
   *  last-focused tab's conversation), or null when unavailable. */
  loadIndex: (idOrCurrent: string) => Promise<ConversationIndex | null>;
  /** The current (last-focused) conversation id, or null. */
  currentConvId: () => string | null;
  /** Read one conv-scoped storage kind for an arbitrary conversation. */
  getConv: (convId: string, kind: "pins" | "notes" | "highlights") => Promise<unknown>;
}

export type BridgeReadResult =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

function apiFail(error: ApiError, status?: number): BridgeReadResult {
  const code = error === "aborted" ? "aborted" : "api_error";
  return {
    ok: false,
    code,
    message: `Couldn't read from claude.ai (${error}${status ? ` ${status}` : ""}).`,
  };
}

const NO_CONV: BridgeReadResult = {
  ok: false,
  code: "no_conversation",
  message: "No conversation is open — open a claude.ai chat, or pass a conversation id.",
};

function resolveConvId(deps: BridgeReadDeps, p: Record<string, unknown>): string | null {
  const cid = typeof p["conversation_id"] === "string" && p["conversation_id"] ? p["conversation_id"] : null;
  return cid ?? deps.currentConvId();
}

/**
 * Dispatch one read method to its live source and shape the spec §5 output.
 * Result keys match bridge/src/mcp-server.js's expectation EXACTLY (the bridge
 * passes `result` straight through as the tool's structuredContent).
 */
export async function runBridgeRead(
  deps: BridgeReadDeps,
  method: string,
  params: unknown,
): Promise<BridgeReadResult> {
  const p = isRecordLike(params) ? params : {};

  switch (method) {
    case "list_recent_conversations": {
      const limit = num(p["limit"]);
      const res = await deps.getConversations({ limit: clamp(limit, MAX_LIST, DEFAULT_LIST) });
      if (!res.ok) return apiFail(res.error, res.status);
      return { ok: true, result: shapeRecent(res.data, limit) };
    }

    case "search_conversations": {
      const query = typeof p["query"] === "string" ? p["query"] : "";
      const res = await deps.getConversations({ limit: SEARCH_FETCH_LIMIT });
      if (!res.ok) return apiFail(res.error, res.status);
      return { ok: true, result: shapeSearch(res.data, query, num(p["limit"])) };
    }

    case "get_conversation": {
      const id = typeof p["id"] === "string" && p["id"] ? p["id"] : "current";
      const scope: BodyScope = p["scope"] === "claude" ? "claude" : "all";
      const index = await deps.loadIndex(id);
      if (!index) return NO_CONV;
      return { ok: true, result: shapeConversation(index, scope) };
    }

    case "get_pins": {
      const convId = resolveConvId(deps, p);
      if (!convId) return NO_CONV;
      const raw = await deps.getConv(convId, "pins");
      const pinned = Array.isArray(raw) ? (raw.filter((x) => typeof x === "string") as string[]) : [];
      const index = pinned.length > 0 ? await deps.loadIndex(convId) : null;
      return { ok: true, result: shapePins(pinned, index) };
    }

    case "get_notes": {
      const convId = resolveConvId(deps, p);
      if (!convId) return NO_CONV;
      return { ok: true, result: shapeNotes(await deps.getConv(convId, "notes")) };
    }

    case "get_highlights": {
      const convId = resolveConvId(deps, p);
      if (!convId) return NO_CONV;
      return { ok: true, result: shapeHighlights(await deps.getConv(convId, "highlights")) };
    }

    default:
      return { ok: false, code: "unsupported_method", message: `Unknown method: ${method}` };
  }
}
