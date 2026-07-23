/**
 * Unit tests for the Claude Code bridge READ shapers (features/claude-code-
 * bridge/reads.ts) — the pure core of the reverse-direction tools (spec §5).
 * No DOM, no browser APIs.
 *
 * Invariants under test:
 * 1. Each shaper emits EXACTLY the spec §5 output keys (the bridge forwards the
 *    result object straight through as the tool's structuredContent).
 * 2. Sizes are bounded — list lengths capped, text bodies truncated.
 * 3. The orchestrator routes by method, resolves "current"/conversation_id, and
 *    returns clean error frames (no_conversation / unsupported_method).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatUrl,
  indexFromConversation,
  runBridgeRead,
  shapeConversation,
  shapeHighlights,
  shapeNotes,
  shapePins,
  shapeRecent,
  shapeSearch,
  type BridgeReadDeps,
} from "../src/features/claude-code-bridge/reads.ts";
import type { ConversationIndex } from "../src/core/conversation-store.ts";
import type { Conversation, ConversationStub } from "../src/api/types.ts";

const index: ConversationIndex = {
  convId: "abc123",
  name: "Rate limiter",
  model: null,
  source: "api",
  fetchedAt: 0,
  messages: [
    { uuid: "u1", sender: "human", text: "How do I rate limit?", createdAt: "2026-07-23T14:00:00Z", index: 0 },
    { uuid: "a1", sender: "assistant", text: "Use a token bucket.", createdAt: "2026-07-23T14:01:00Z", index: 1 },
  ],
};

const stubs: ConversationStub[] = [
  { uuid: "c1", name: "Rate limiter for the queue", updated_at: "2026-07-23T14:00:00Z" },
  { uuid: "c2", name: "Dockerfile review", updated_at: "2026-07-22T09:00:00Z" },
  { uuid: "c3", name: "", updated_at: "2026-07-21T09:00:00Z" },
];

test("chatUrl builds the canonical conversation URL", () => {
  assert.equal(chatUrl("abc123"), "https://claude.ai/chat/abc123");
});

test("shapeRecent emits {id,title,updated_at,url} and caps the list", () => {
  const out = shapeRecent(stubs, undefined);
  assert.deepEqual(Object.keys(out), ["conversations"]);
  assert.deepEqual(out.conversations[0], {
    id: "c1",
    title: "Rate limiter for the queue",
    updated_at: "2026-07-23T14:00:00Z",
    url: "https://claude.ai/chat/c1",
  });
  assert.equal(out.conversations[2]?.title, "(untitled)"); // empty name filled
  // limit is clamped: a huge limit never overflows the pool.
  assert.equal(shapeRecent(stubs, 999).conversations.length, 3);
  // a small limit truncates.
  assert.equal(shapeRecent(stubs, 1).conversations.length, 1);
});

test("shapeSearch matches titles case-insensitively and emits a snippet", () => {
  const out = shapeSearch(stubs, "RATE", undefined);
  assert.deepEqual(Object.keys(out), ["results"]);
  assert.equal(out.results.length, 1);
  assert.deepEqual(out.results[0], {
    id: "c1",
    title: "Rate limiter for the queue",
    url: "https://claude.ai/chat/c1",
    snippet: "Rate limiter for the queue",
  });
  assert.equal(shapeSearch(stubs, "nomatch", undefined).results.length, 0);
});

test("shapeConversation returns {id,title,url,markdown} from the handoff serializer", () => {
  const out = shapeConversation(index, "all");
  assert.deepEqual(Object.keys(out), ["id", "title", "url", "markdown"]);
  assert.equal(out.id, "abc123");
  assert.equal(out.url, "https://claude.ai/chat/abc123");
  assert.match(out.markdown, /# Claude web chat handoff — Rate limiter/);
  assert.match(out.markdown, /## You/);
  assert.match(out.markdown, /## Claude/);
  // "claude" scope drops the human turn.
  assert.doesNotMatch(shapeConversation(index, "claude").markdown, /## You/);
});

test("shapePins joins bare uuids to index text + timestamp", () => {
  const out = shapePins(["a1", "missing"], index);
  assert.deepEqual(out.pins[0], {
    id: "a1",
    text: "Use a token bucket.",
    message_id: "a1",
    created_at: "2026-07-23T14:01:00Z",
  });
  // uuid absent from the index → empty text, null timestamp, still addressable.
  assert.deepEqual(out.pins[1], { id: "missing", text: "", message_id: "missing", created_at: null });
  // no index at all → all text empty.
  assert.equal(shapePins(["a1"], null).pins[0]?.text, "");
});

test("shapeNotes accepts NoteRecord[] and legacy string, excludes todo items", () => {
  const fromRecords = shapeNotes([
    { id: "n1", text: "remember this", at: "2026-07-23T14:00:00Z", up: "2026-07-23T14:00:00Z" },
    { id: "t1", text: "a todo", done: false }, // todo item — excluded
  ]);
  assert.deepEqual(fromRecords.notes, [
    { id: "n1", text: "remember this", created_at: "2026-07-23T14:00:00Z" },
  ]);
  const legacy = shapeNotes("legacy scratchpad");
  assert.deepEqual(legacy.notes, [{ id: "notes", text: "legacy scratchpad", created_at: null }]);
  assert.deepEqual(shapeNotes("").notes, []);
});

test("shapeHighlights emits {text,message_id}, null uuid tolerated", () => {
  const out = shapeHighlights([
    { id: "h1", uuid: "a1", text: "token bucket", at: "x" },
    { id: "h2", uuid: null, text: "unresolved" },
  ]);
  assert.deepEqual(out.highlights, [
    { text: "token bucket", message_id: "a1" },
    { text: "unresolved", message_id: null },
  ]);
});

test("indexFromConversation mirrors the store mapping (attachment labels)", () => {
  const conv: Conversation = {
    uuid: "z9",
    name: "",
    model: "claude",
    created_at: "x",
    updated_at: "y",
    chat_messages: [
      { uuid: "m1", sender: "human", content: [{ type: "text", text: "hi" }], created_at: "t0" },
      { uuid: "m2", sender: "assistant", content: [], created_at: "t1", files: [{}, {}] },
      { uuid: "m3", sender: "assistant", content: [], created_at: "t2" },
    ],
  };
  const idx = indexFromConversation(conv);
  assert.equal(idx.name, "(untitled)");
  assert.equal(idx.messages[0]?.text, "hi");
  assert.equal(idx.messages[1]?.text, "📎 2 attachments");
  assert.equal(idx.messages[2]?.text, "(empty message)");
});

test("shape functions truncate oversized bodies", () => {
  const long = "x".repeat(5000);
  const pins = shapePins(["a1"], {
    ...index,
    messages: [{ uuid: "a1", sender: "assistant", text: long, createdAt: null, index: 0 }],
  });
  assert.ok(pins.pins[0]!.text.length < long.length);
  assert.match(pins.pins[0]!.text, /\[truncated\]$/);
});

// ---- orchestrator ----------------------------------------------------------

function deps(over: Partial<BridgeReadDeps> = {}): BridgeReadDeps {
  return {
    getConversations: async () => ({ ok: true, data: stubs }),
    loadIndex: async (id) => (id === "current" || id === "abc123" ? index : null),
    currentConvId: () => "abc123",
    getConv: async () => [],
    ...over,
  };
}

test("runBridgeRead routes list_recent_conversations to the stub source", async () => {
  const out = await runBridgeRead(deps(), "list_recent_conversations", { limit: 2 });
  assert.ok(out.ok);
  assert.deepEqual(Object.keys(out.result as object), ["conversations"]);
});

test("runBridgeRead resolves get_conversation('current')", async () => {
  const out = await runBridgeRead(deps(), "get_conversation", { id: "current" });
  assert.ok(out.ok);
  assert.equal((out.result as { id: string }).id, "abc123");
});

test("runBridgeRead resolves get_pins via conversation_id + storage", async () => {
  const out = await runBridgeRead(
    deps({ getConv: async () => ["a1"], currentConvId: () => null }),
    "get_pins",
    { conversation_id: "abc123" },
  );
  assert.ok(out.ok);
  assert.equal((out.result as { pins: unknown[] }).pins.length, 1);
});

test("runBridgeRead errors cleanly with no conversation", async () => {
  const out = await runBridgeRead(deps({ currentConvId: () => null }), "get_notes", {});
  assert.equal(out.ok, false);
  assert.equal((out as { code: string }).code, "no_conversation");
});

test("runBridgeRead surfaces an API failure as api_error", async () => {
  const out = await runBridgeRead(
    deps({ getConversations: async () => ({ ok: false, error: "http", status: 500 }) }),
    "list_recent_conversations",
    {},
  );
  assert.equal(out.ok, false);
  assert.equal((out as { code: string }).code, "api_error");
});

test("runBridgeRead rejects an unknown method", async () => {
  const out = await runBridgeRead(deps(), "delete_everything", {});
  assert.equal(out.ok, false);
  assert.equal((out as { code: string }).code, "unsupported_method");
});
