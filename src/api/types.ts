/**
 * Types for the (unofficial) claude.ai internal API, trimmed to the fields we
 * actually consume. Guards (`guards.ts`) validate only these fields — a shape
 * drift on anything else can't hurt us.
 *
 * Verified against the live claude.ai API (2026-07-21).
 */

export interface Org {
  uuid: string;
  capabilities?: string[];
}

export interface MessageContentBlock {
  type: string;
  text?: string;
}

export interface ChatMessage {
  uuid: string;
  sender: "human" | "assistant";
  content: MessageContentBlock[];
  created_at: string;
  /** Present on attachment-carrying messages; only the count is consumed
   *  (attachment-aware labels for text-less messages). */
  files?: unknown[];
  attachments?: unknown[];
  /** NOTE: the API carries NO per-message model. Only conversation-level
   *  `model` (the current selection) exists — see meta-line feature notes. */
}

export interface Conversation {
  uuid: string;
  name: string;
  model: string | null;
  created_at: string;
  updated_at: string;
  chat_messages: ChatMessage[];
}

export interface ConversationStub {
  uuid: string;
  name: string;
  updated_at: string;
  is_starred?: boolean;
}

export interface UsageWindow {
  utilization: number;
  resets_at: string;
}

/**
 * One entry of the newer `/usage` `limits[]` array. Every field is
 * optional — the guard only requires entries to be objects; consumers render
 * defensively and skip entries without a numeric `percent`.
 */
export interface UsageLimit {
  kind?: string; // "session" | "weekly_all" | per-model kinds
  percent?: number;
  severity?: string; // "ok" | "warning" | "critical" (observed)
  resets_at?: string;
  is_active?: boolean;
  scope?: { model?: { display_name?: string } };
}

export interface UsageSpend {
  enabled?: boolean;
  used?: { amount_minor: number; exponent: number; currency: string };
}

export interface Usage {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  seven_day_cowork?: UsageWindow | null;
  /** Newer response shape; when present it supersedes the window fields. */
  limits?: UsageLimit[];
  spend?: UsageSpend;
}

export interface RateLimits {
  rate_limit_tier: string;
  tier_model_rate_limiters: unknown[];
}

export interface Project {
  uuid: string;
  name: string;
  description?: string;
  is_starred?: boolean;
}

export interface Account {
  uuid: string;
  email: string;
  display_name?: string;
}

/** Discriminated result — the client never throws for expected failure modes. */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError; status?: number };

export type ApiError = "network" | "http" | "schema" | "aborted";

/** Extract the message text of a chat message (concatenate text blocks). */
export function messageText(message: ChatMessage): string {
  return message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
}
