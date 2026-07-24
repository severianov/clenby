/**
 * Unit tests for the EventBus correlation contract on the Claude Code send
 * pipeline. FOUR sender surfaces (answer-toolbar / outline / notes / export)
 * share the one "bridge:send" → "bridge:send-result" round-trip; the optional
 * `reqId` token is what lets each settle ONLY its own result. Without it any
 * feature holding a pending ref consumes the next result to land — wrong-button
 * flashes, never-resolving buttons, an earlier queued result eating a later
 * send. These pin that invariant at the bus level (no DOM), mirroring the guard
 * every sender applies:  if (!pending || result.reqId !== pending.reqId) return;
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/event-bus.ts";
import type { CompanionEvents } from "../src/core/event-bus.ts";

test("emit delivers a payload to every subscriber", () => {
  const bus = new EventBus();
  const seen: number[] = [];
  bus.on("bridge:send-result", () => seen.push(1));
  bus.on("bridge:send-result", () => seen.push(2));
  bus.emit("bridge:send-result", { ok: true, reqId: "r1" });
  assert.deepEqual(seen.sort(), [1, 2]);
});

test("a throwing subscriber never blocks the others", () => {
  const bus = new EventBus();
  let reached = false;
  bus.on("bridge:send-result", () => {
    throw new Error("bad subscriber");
  });
  bus.on("bridge:send-result", () => {
    reached = true;
  });
  bus.emit("bridge:send-result", { ok: false, reqId: "r1" });
  assert.equal(reached, true);
});

/** A stand-in for one sender surface: holds a pending correlation token and
 *  settles ONLY on the result that echoes it — exactly the guard the four
 *  features apply against their pending ref. */
function makeSender(bus: EventBus) {
  const s = { pending: null as string | null, settled: null as boolean | null };
  bus.on("bridge:send-result", ({ ok, reqId }) => {
    if (s.pending === null || reqId !== s.pending) return;
    s.pending = null;
    s.settled = ok;
  });
  return {
    send(reqId: string): void {
      s.pending = reqId;
      bus.emit("bridge:send", { handle: "context", scope: "notes", reqId });
    },
    get pending(): string | null {
      return s.pending;
    },
    get settled(): boolean | null {
      return s.settled;
    },
  };
}

test("a result settles only the sender whose reqId it echoes", () => {
  const bus = new EventBus();
  const a = makeSender(bus);
  const b = makeSender(bus);
  a.send("A-token");
  b.send("B-token");

  // B's result lands first (out-of-order async completion) — only B settles.
  bus.emit("bridge:send-result", { ok: true, reqId: "B-token" });
  assert.equal(b.settled, true);
  assert.equal(b.pending, null);
  assert.equal(a.settled, null, "A must not consume B's result");
  assert.equal(a.pending, "A-token", "A stays pending for its own result");

  // A's result lands second — A now settles, carrying ITS OWN verdict.
  bus.emit("bridge:send-result", { ok: false, reqId: "A-token" });
  assert.equal(a.settled, false);
  assert.equal(a.pending, null);
});

test("a reqId-less or unknown result settles no pending sender", () => {
  const bus = new EventBus();
  const a = makeSender(bus);
  a.send("A-token");

  // Legacy / foreign result with no correlation token: ignored while a real
  // token is pending — the sender never mistakes it for its own.
  bus.emit("bridge:send-result", { ok: true });
  assert.equal(a.settled, null);
  assert.equal(a.pending, "A-token");

  // A stranger's token is likewise ignored.
  bus.emit("bridge:send-result", { ok: true, reqId: "someone-else" });
  assert.equal(a.settled, null);
  assert.equal(a.pending, "A-token");
});

// ---------------------------------------------------------------------------
// bridge:send-lifecycle — the status bar's ambient send narration. The
// claude-code-bridge feature is the SOLE producer; these pin the payload shape
// at compile time (the emit calls only type-check against the declared union +
// field types) and confirm the three phases carry through the bus.
// ---------------------------------------------------------------------------

test("bridge:send-lifecycle carries phase/target/reason and echoes reqId", () => {
  const bus = new EventBus();
  const seen: Array<CompanionEvents["bridge:send-lifecycle"]> = [];
  bus.on("bridge:send-lifecycle", (p) => seen.push(p));

  // Typed literals PIN the shape: `phase` is the "sending"|"received"|"failed"
  // union, `target` is a required string, `reason`/`reqId` are optional. A wrong
  // phase or a missing target would fail `npx tsc --noEmit`.
  const sending: CompanionEvents["bridge:send-lifecycle"] = {
    phase: "sending",
    target: "clenby · calm-falcon",
    reqId: "r1",
  };
  const received: CompanionEvents["bridge:send-lifecycle"] = {
    phase: "received",
    target: "clenby · calm-falcon",
    reqId: "r1",
  };
  const failed: CompanionEvents["bridge:send-lifecycle"] = {
    phase: "failed",
    target: "",
    reason: "No session connected.",
    reqId: "r2",
  };
  bus.emit("bridge:send-lifecycle", sending);
  bus.emit("bridge:send-lifecycle", received);
  bus.emit("bridge:send-lifecycle", failed);

  assert.deepEqual(
    seen.map((p) => p.phase),
    ["sending", "received", "failed"],
  );
  assert.equal(seen[0]?.target, "clenby · calm-falcon");
  assert.equal(seen[0]?.reason, undefined); // "sending" carries no reason
  assert.equal(seen[2]?.reason, "No session connected.");
  assert.equal(seen[2]?.reqId, "r2");
});
