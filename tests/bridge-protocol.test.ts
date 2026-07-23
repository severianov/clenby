/**
 * Unit tests for the bridge wire protocol (shared/bridge-protocol.ts) — the
 * envelope guards the background trusts. The security posture depends on
 * refusing anything outside the schema (threat model §6), so the guards are the
 * gate under test here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_PORTS,
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  helloFrame,
  isBridgeBackgroundMessage,
  isBridgeContentMessage,
  parseInboundFrame,
  pushFrame,
  shortIdOf,
} from "../src/shared/bridge-protocol.ts";

test("the scanned range is exactly 47850–47859 (10 ports, spec §4)", () => {
  assert.equal(BRIDGE_PORT_MIN, 47850);
  assert.equal(BRIDGE_PORT_MAX, 47859);
  assert.equal(BRIDGE_PORTS.length, 10);
  assert.equal(BRIDGE_PORTS[0], 47850);
  assert.equal(BRIDGE_PORTS[9], 47859);
});

test("shortIdOf is the first 4 hex of the sessionId", () => {
  assert.equal(shortIdOf("a3f1b2c4-dead-beef-0000-111122223333"), "a3f1");
  assert.equal(shortIdOf("A3F1XYZ"), "a3f1"); // lowercased, non-hex skipped
});

test("parseInboundFrame accepts each valid bridge→extension frame", () => {
  const welcome = parseInboundFrame(
    JSON.stringify({ v: 1, t: "welcome", sessionId: "s1", project: "clenby", path: "/tmp/clenby" }),
  );
  assert.equal(welcome?.t, "welcome");

  assert.equal(parseInboundFrame(JSON.stringify({ v: 1, t: "error", code: "unauthorized" }))?.t, "error");
  assert.equal(
    parseInboundFrame(JSON.stringify({ v: 1, t: "req", id: "r1", method: "push_to_composer" }))?.t,
    "req",
  );
  assert.equal(parseInboundFrame(JSON.stringify({ v: 1, t: "ack", id: "i1" }))?.t, "ack");
  assert.equal(parseInboundFrame(JSON.stringify({ v: 1, t: "ping" }))?.t, "ping");
});

test("parseInboundFrame refuses malformed, unknown, and outbound-only frames", () => {
  assert.equal(parseInboundFrame("not json"), null);
  assert.equal(parseInboundFrame(JSON.stringify({ v: 1, t: "welcome" })), null); // missing fields
  assert.equal(parseInboundFrame(JSON.stringify({ v: 1, t: "req", id: "r1" })), null); // no method
  assert.equal(parseInboundFrame(JSON.stringify({ v: 1, t: "ack" })), null); // no id
  assert.equal(parseInboundFrame(JSON.stringify({ v: 1, t: "hello", token: "x" })), null); // outbound
  assert.equal(parseInboundFrame(JSON.stringify({ v: 1, t: "push", id: "p" })), null); // outbound
  assert.equal(parseInboundFrame(JSON.stringify({ t: "wat" })), null);
  assert.equal(parseInboundFrame("42"), null);
});

test("helloFrame + pushFrame carry the spec envelope shape", () => {
  const hello = helloFrame("clenby_tok", "9.9.9");
  assert.deepEqual(hello, {
    v: 1,
    t: "hello",
    token: "clenby_tok",
    client: "clenby-ext",
    ext_version: "9.9.9",
  });

  const push = pushFrame({
    id: "item-1",
    handle: "review",
    scope: "answer",
    source_id: "conv1",
    sent_at: "2026-07-23T00:00:00.000Z",
    markdown: "---\nschema: clenby.handoff/1\n",
  });
  assert.equal(push.t, "push");
  assert.equal(push.topic, "handoff");
  assert.equal(push.id, "item-1");
  assert.deepEqual(push.meta, {
    handle: "review",
    scope: "answer",
    source_id: "conv1",
    sent_at: "2026-07-23T00:00:00.000Z",
  });
  assert.ok(push.markdown.startsWith("---"));
});

test("isBridgeContentMessage gates the background's message surface", () => {
  assert.ok(isBridgeContentMessage({ type: "cc:bridge:status" }));
  assert.ok(isBridgeContentMessage({ type: "cc:bridge:pair", code: "clenby_x" }));
  assert.ok(isBridgeContentMessage({ type: "cc:bridge:forget" }));
  assert.ok(
    isBridgeContentMessage({
      type: "cc:bridge:push",
      sessionId: "s1",
      id: "i1",
      markdown: "x",
      meta: { handle: "continue", scope: "conversation", source_id: "c", sent_at: "t" },
    }),
  );
  // Rejections.
  assert.ok(!isBridgeContentMessage({ type: "cc:bridge:pair" })); // no code
  assert.ok(!isBridgeContentMessage({ type: "cc:bridge:push", sessionId: "s1" })); // incomplete
  assert.ok(!isBridgeContentMessage({ type: "cc:anthropic:status" }));
  assert.ok(!isBridgeContentMessage(null));
  assert.ok(!isBridgeContentMessage("cc:bridge:status"));
});

test("isBridgeBackgroundMessage gates the content's inbound surface", () => {
  assert.ok(isBridgeBackgroundMessage({ type: "cc:bridge:roster", status: { sessions: [] } }));
  assert.ok(isBridgeBackgroundMessage({ type: "cc:bridge:push-to-composer", text: "draft" }));
  assert.ok(!isBridgeBackgroundMessage({ type: "cc:bridge:roster" })); // no status
  assert.ok(!isBridgeBackgroundMessage({ type: "cc:bridge:push-to-composer" })); // no text
  assert.ok(!isBridgeBackgroundMessage({ type: "cc:bridge:status" }));
});

test("parseInboundFrame accepts pong (two-sided heartbeat) and hard-rejects future versions", () => {
  // The heartbeat contract is symmetric: the bridge answers our pings with
  // pongs, and those must pass the envelope gate rather than read as noise.
  const pong = parseInboundFrame(JSON.stringify({ v: 1, t: "pong" }));
  assert.equal(pong?.t, "pong");
  // CCB-4: a v2 frame of an otherwise-known type is refused, not misparsed.
  assert.equal(parseInboundFrame(JSON.stringify({ v: 2, t: "ack", id: "x" })), null);
  assert.equal(parseInboundFrame(JSON.stringify({ v: 2, t: "pong" })), null);
});

test("pushFrame carries source_title in meta so the bridge never re-parses it from frontmatter", () => {
  const withTitle = pushFrame({
    id: "i2",
    handle: "continue",
    scope: "conversation",
    source_id: "conv2",
    source_title: 'Fix #42 and the "weird" case',
    sent_at: "2026-07-24T00:00:00.000Z",
    markdown: "---\nx: 1\n---\nbody",
  });
  assert.equal(withTitle.meta.source_title, 'Fix #42 and the "weird" case');
  // Omitted title ⇒ key absent (wire stays byte-identical for old payloads).
  const without = pushFrame({
    id: "i3",
    handle: "context",
    scope: "answer",
    source_id: "conv3",
    sent_at: "2026-07-24T00:00:00.000Z",
    markdown: "x",
  });
  assert.ok(!("source_title" in without.meta));
});
