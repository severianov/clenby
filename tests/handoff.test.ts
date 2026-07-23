/**
 * Unit tests for the handoff assembly (shared/handoff.ts) — the pure core of
 * the web→code payload. No DOM, no browser APIs.
 *
 * Invariants under test:
 * 1. The frontmatter carries the full spec §2 field set, in order, with the
 *    title safely quoted (a colon in a title must not break the YAML).
 * 2. The verbatim pre-prompt for the chosen handle sits between the
 *    frontmatter and the body, framed by `---`.
 * 3. The conversation-body serializer matches the shipped `## You` / `## Claude`
 *    format the export feature relied on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDLE_PREPROMPTS,
  HANDOFF_HANDLES,
  HANDOFF_SCHEMA,
  assembleHandoff,
  buildAnswerBody,
  buildHandoffMarkdown,
  handoffFrontmatter,
  type HandoffMeta,
} from "../src/shared/handoff.ts";
import type { ConversationIndex } from "../src/core/conversation-store.ts";

const FIXED = new Date("2026-07-23T14:08:00.000Z");

const index: ConversationIndex = {
  convId: "abc123",
  name: "Rate limiter: the ingest queue",
  model: null,
  source: "api",
  fetchedAt: 0,
  messages: [
    { uuid: "u1", sender: "human", text: "How do I rate limit?", createdAt: null, index: 0 },
    { uuid: "a1", sender: "assistant", text: "Use a token bucket.", createdAt: null, index: 1 },
  ],
};

const meta = (over: Partial<HandoffMeta> = {}): HandoffMeta => ({
  handle: "continue",
  scope: "conversation",
  source_url: "https://claude.ai/chat/abc123",
  source_id: "abc123",
  source_title: "Rate limiter: the ingest queue",
  sent_at: "2026-07-23T14:08:00.000Z",
  message_count: 2,
  app_version: "1.2.3",
  body_fence: "deadbeef",
  ...over,
});

test("frontmatter carries the full field set in order, title safely quoted", () => {
  const fm = handoffFrontmatter(meta());
  assert.ok(fm.startsWith("---\n"));
  assert.ok(fm.endsWith("\n---"));
  assert.match(fm, /schema: "clenby\.handoff\/1"/);
  assert.match(fm, /handle: "continue"/);
  assert.match(fm, /scope: "conversation"/);
  assert.match(fm, /source_url: "https:\/\/claude\.ai\/chat\/abc123"/);
  assert.match(fm, /source_id: "abc123"/);
  // A colon in the title must be quoted, not break YAML.
  assert.match(fm, /source_title: "Rate limiter: the ingest queue"/);
  assert.match(fm, /message_count: 2/); // number, unquoted
  assert.match(fm, /app: "clenby"/);
  assert.match(fm, /app_version: "1\.2\.3"/);
  assert.match(fm, /body_fence: "deadbeef"/);
  // Field order: schema before handle before scope before source_url.
  const at = (k: string): number => fm.indexOf(k);
  assert.ok(at("schema:") < at("handle:"));
  assert.ok(at("handle:") < at("scope:"));
  assert.ok(at("scope:") < at("source_url:"));
  assert.ok(at("sent_at:") < at("message_count:"));
});

test("answer scope adds answer_id, omits it for conversation scope", () => {
  const conv = handoffFrontmatter(meta());
  assert.ok(!conv.includes("answer_id"));
  const ans = handoffFrontmatter(meta({ scope: "answer", answer_id: "a1", message_count: 1 }));
  assert.match(ans, /answer_id: "a1"/);
});

test("selection scope omits answer_id and message_count", () => {
  const fm = handoffFrontmatter(meta({ scope: "selection", message_count: undefined }));
  assert.ok(!fm.includes("answer_id"));
  assert.ok(!fm.includes("message_count"));
});

test("assembleHandoff frames the body with the verbatim pre-prompt inside a nonce fence", () => {
  const out = assembleHandoff(meta(), "BODY-CONTENT", "deadbeef");
  assert.ok(out.startsWith(`---\nschema: "${HANDOFF_SCHEMA}"`));
  assert.ok(out.includes("\n\n" + HANDLE_PREPROMPTS.continue + "\n\n"));
  // The body is wrapped in BEGIN/END markers carrying the live nonce, and the
  // framing sentence names the same fence (security review CCB-2).
  assert.ok(out.includes("===== BEGIN CLAUDE.AI HANDOFF DATA · fence deadbeef ====="));
  assert.ok(out.includes("===== END CLAUDE.AI HANDOFF DATA · fence deadbeef ====="));
  assert.ok(out.includes("`fence deadbeef`"));
  assert.ok(out.includes("BODY-CONTENT"));
  // Body sits BETWEEN the markers, END marker last.
  const b = out.indexOf("BEGIN CLAUDE.AI HANDOFF");
  const body = out.indexOf("BODY-CONTENT");
  const e = out.indexOf("END CLAUDE.AI HANDOFF");
  assert.ok(b < body && body < e, "body between the fence markers");
});

test("each handle injects its own verbatim pre-prompt", () => {
  for (const h of HANDOFF_HANDLES) {
    const out = assembleHandoff(meta({ handle: h }), "x", "abcd1234");
    assert.ok(out.includes(HANDLE_PREPROMPTS[h]), `handle ${h} pre-prompt present`);
  }
  // The three are distinct and open with the shared framing sentence.
  for (const h of HANDOFF_HANDLES) {
    assert.match(HANDLE_PREPROMPTS[h], /^The block below is a handoff exported from a claude\.ai/);
  }
  assert.notEqual(HANDLE_PREPROMPTS.continue, HANDLE_PREPROMPTS.review);
  assert.notEqual(HANDLE_PREPROMPTS.review, HANDLE_PREPROMPTS.context);
});

test("conversation body serializer matches the shipped export format", () => {
  const md = buildHandoffMarkdown(index, "all", FIXED);
  assert.ok(md.startsWith("# Claude web chat handoff — Rate limiter: the ingest queue\n\n"));
  assert.match(md, /_full conversation · 2 messages · exported 2026-07-23 14:08 UTC_/);
  assert.ok(md.includes("## You\n\nHow do I rate limit?"));
  assert.ok(md.includes("## Claude\n\nUse a token bucket."));
});

test("claude-only body drops the human turns", () => {
  const md = buildHandoffMarkdown(index, "claude", FIXED);
  assert.ok(!md.includes("## You"));
  assert.match(md, /1 messages/);
  assert.ok(md.includes("## Claude\n\nUse a token bucket."));
});

test("answer body serializes a single Claude turn", () => {
  const md = buildAnswerBody("A title", "one answer", FIXED);
  assert.ok(md.startsWith("# Claude web chat handoff — A title"));
  assert.match(md, /Claude’s answer · 1 message · exported 2026-07-23 14:08 UTC/);
  assert.ok(md.includes("## Claude\n\none answer"));
});
