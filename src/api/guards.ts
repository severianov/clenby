/**
 * Hand-rolled runtime shape validators — no schema library (the zero-runtime-
 * dependency rule). Every API response passes its
 * guard before being typed; a guard failure becomes `{ok:false,error:"schema"}`
 * so `undefined` can never propagate into a feature.
 */

import type {
  Account,
  ChatMessage,
  Conversation,
  ConversationStub,
  MessageContentBlock,
  Org,
  Project,
  RateLimits,
  Usage,
  UsageWindow,
} from "./types";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

export function isOrg(v: unknown): v is Org {
  return isObject(v) && isStr(v["uuid"]);
}
export function isOrgArray(v: unknown): v is Org[] {
  return isArr(v) && v.every(isOrg);
}

function isContentBlock(v: unknown): v is MessageContentBlock {
  return isObject(v) && isStr(v["type"]) && (v["text"] === undefined || isStr(v["text"]));
}

export function isChatMessage(v: unknown): v is ChatMessage {
  return (
    isObject(v) &&
    isStr(v["uuid"]) &&
    (v["sender"] === "human" || v["sender"] === "assistant") &&
    isArr(v["content"]) &&
    v["content"].every(isContentBlock) &&
    isStr(v["created_at"])
  );
}

export function isConversation(v: unknown): v is Conversation {
  return (
    isObject(v) &&
    isStr(v["uuid"]) &&
    isStr(v["name"]) &&
    (v["model"] === null || isStr(v["model"])) &&
    isStr(v["created_at"]) &&
    isStr(v["updated_at"]) &&
    isArr(v["chat_messages"]) &&
    v["chat_messages"].every(isChatMessage)
  );
}

export function isConversationStub(v: unknown): v is ConversationStub {
  return isObject(v) && isStr(v["uuid"]) && isStr(v["name"]) && isStr(v["updated_at"]);
}
export function isConversationStubArray(v: unknown): v is ConversationStub[] {
  return isArr(v) && v.every(isConversationStub);
}

function isUsageWindow(v: unknown): v is UsageWindow {
  return isObject(v) && isNum(v["utilization"]) && isStr(v["resets_at"]);
}
function isUsageWindowOrNull(v: unknown): v is UsageWindow | null {
  return v === null || v === undefined || isUsageWindow(v);
}

export function isUsage(v: unknown): v is Usage {
  if (!isObject(v)) return false;
  if (!isUsageWindowOrNull(v["five_hour"]) || !isUsageWindowOrNull(v["seven_day"])) return false;
  // Newer `limits[]` shape: deliberately lenient — entries need only be
  // objects (all UsageLimit fields are optional; the usage feature skips
  // entries without a numeric `percent`), so a partial drift degrades one row,
  // not the whole popover.
  const limits = v["limits"];
  if (limits !== undefined && (!isArr(limits) || !limits.every(isObject))) return false;
  return true;
}

export function isRateLimits(v: unknown): v is RateLimits {
  return isObject(v) && isStr(v["rate_limit_tier"]) && isArr(v["tier_model_rate_limiters"]);
}

export function isProject(v: unknown): v is Project {
  return isObject(v) && isStr(v["uuid"]) && isStr(v["name"]);
}
export function isProjectArray(v: unknown): v is Project[] {
  return isArr(v) && v.every(isProject);
}

export function isAccount(v: unknown): v is Account {
  return isObject(v) && isStr(v["uuid"]) && isStr(v["email"]);
}
