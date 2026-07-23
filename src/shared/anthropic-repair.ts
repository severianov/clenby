/**
 * The OPT-IN Anthropic-API repair tier — shared protocol between the repair
 * UI (content script) and the background worker.
 *
 * Why the background does everything: `browser.permissions.*` is unavailable
 * in content scripts, and fetching api.anthropic.com from the page context
 * would be subject to claude.ai's CSP/CORS. The content script only ever
 * sends these messages; the background requests the OPTIONAL host permission,
 * holds the key in `storage.local`, and performs the one fetch.
 *
 * Privacy/scope invariants:
 * - The prompt is the sanitized structure-only bundle (shared/repair-sketch)
 *   — no conversation text can reach it by construction.
 * - `https://api.anthropic.com/*` is an `optional_host_permissions` entry,
 *   requested at opt-in time via `permissions.request`. The BASE install
 *   stays claude.ai-only.
 * - This module is types + constants only — no runtime browser APIs, so both
 *   contexts (and tests) can import it freely.
 */

/** The optional host permission requested at opt-in time. */
export const ANTHROPIC_API_ORIGIN = "https://api.anthropic.com/*";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** One small Haiku-class call per repair (scope doc §4.2) — the cheapest
 *  current model; a repair costs well under a cent. */
export const REPAIR_MODEL = "claude-haiku-4-5";
export const REPAIR_MAX_TOKENS = 300;

/** Hard cap on what the background will forward — the sketch builder stays
 *  far below this; anything bigger is a bug, not a bigger page. */
export const REPAIR_MAX_PROMPT_CHARS = 20_000;

/** Where the session flow points the user for the guided chat. */
export const CLAUDE_NEW_CHAT_URL = "https://claude.ai/new";

// ---------------------------------------------------------------------------
// Messages (content → background)
// ---------------------------------------------------------------------------

export type AnthropicRepairMessage =
  /** Is the tier usable? → {@link AnthropicStatusResult} */
  | { type: "cc:anthropic:status" }
  /** Opt in: request the optional permission, then store the key. Must be
   *  sent from a user-gesture handler (Chrome forwards the gesture). */
  | { type: "cc:anthropic:enable"; key: string }
  /** Opt out: forget the key and release the optional permission. */
  | { type: "cc:anthropic:disable" }
  /** One repair call: sanitized prompt in, proposed-selector text out. */
  | { type: "cc:anthropic:repair"; prompt: string };

// ---------------------------------------------------------------------------
// Results (background → content)
// ---------------------------------------------------------------------------

export type AnthropicFailure = { ok: false; reason: string };
export type AnthropicStatusResult =
  | { ok: true; hasKey: boolean; hasPermission: boolean }
  | AnthropicFailure;
export type AnthropicEnableResult = { ok: true } | AnthropicFailure;
export type AnthropicRepairResult = { ok: true; text: string } | AnthropicFailure;

/** Runtime guard the background uses before touching a message. */
export function isAnthropicRepairMessage(m: unknown): m is AnthropicRepairMessage {
  if (typeof m !== "object" || m === null) return false;
  const type = (m as { type?: unknown }).type;
  if (type === "cc:anthropic:status" || type === "cc:anthropic:disable") return true;
  if (type === "cc:anthropic:enable") {
    return typeof (m as { key?: unknown }).key === "string";
  }
  if (type === "cc:anthropic:repair") {
    return typeof (m as { prompt?: unknown }).prompt === "string";
  }
  return false;
}
