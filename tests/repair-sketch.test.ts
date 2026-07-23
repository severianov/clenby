/**
 * Unit tests for the pure repair-sketch builders (node --test, no DOM).
 * These tests are the ENFORCEMENT of the privacy invariant: conversation
 * text, content-bearing attribute values, and hashed class noise must never
 * survive into a sketch or prompt.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAncestorPath,
  buildDomSketch,
  buildRepairPrompt,
  describeElement,
  isStableClassToken,
  parseSelectorReply,
  resolvePathPrefix,
  sanitizeClassList,
  type PathableElement,
  type SketchableElement,
} from "../src/shared/repair-sketch.ts";

// ---- fake elements ---------------------------------------------------------

interface FakeEl extends SketchableElement, PathableElement {
  readonly children: FakeEl[];
  parentElement: FakeEl | null;
}

function el(tag: string, attrs: Record<string, string> = {}, children: FakeEl[] = []): FakeEl {
  const node: FakeEl = {
    tagName: tag.toUpperCase(),
    children,
    parentElement: null,
    getAttributeNames: () => Object.keys(attrs),
    getAttribute: (name: string) => (name in attrs ? (attrs[name] as string) : null),
  };
  for (const child of children) child.parentElement = node;
  return node;
}

// ---- class shapes ----------------------------------------------------------

test("class tokens: stable utilities kept, hashes/variants collapsed", () => {
  assert.equal(isStableClassToken("font-claude-response"), true);
  assert.equal(isStableClassToken("bg-bg-300"), true);
  assert.equal(isStableClassToken("max-w-3xl"), true);
  assert.equal(isStableClassToken("css-1a2b3c4d"), false); // css-in-js hash
  assert.equal(isStableClassToken("hover:bg-red-500"), false); // variant needs escaping
  assert.equal(isStableClassToken("bg-[url(/x.png)]"), false); // arbitrary value
  assert.equal(isStableClassToken("a12345678901"), false); // long digit run

  assert.deepEqual(
    sanitizeClassList("font-claude-response css-9f8e7d6c hover:x md:y flex"),
    ["font-claude-response", "…", "flex"], // consecutive collapses dedupe
  );
});

// ---- sketch: structure only, never content ---------------------------------

test("sketch keeps structure and drops everything content-bearing", () => {
  const root = el("div", { class: "conversation css-1a2b3c4d" }, [
    el("button", {
      "aria-label": "Retry response",
      "data-testid": "retry-btn",
      title: "SECRET-TITLE",
      class: "btn-primary",
    }),
    el("img", { src: "https://x/SECRET-IMG.png", alt: "SECRET-ALT" }),
    el("input", { value: "SECRET-VALUE", placeholder: "SECRET-PLACEHOLDER", type: "text" }),
    el("p", { "aria-label": "A".repeat(120) }), // long labels fall back to name-only
  ]);

  const sketch = buildDomSketch(root);

  // Structure survives.
  assert.match(sketch, /div\.conversation\.…/);
  assert.match(sketch, /button\[aria-label="Retry response"\]\[data-testid="retry-btn"\]\.btn-primary/);
  assert.match(sketch, /input\[type="text"\]/);
  assert.match(sketch, /p\[aria-label\]$/m); // name-only, no value

  // Nothing content-bearing survives — not even the attribute names.
  assert.ok(!sketch.includes("SECRET"));
  assert.ok(!/\btitle\b|\balt\b|\bvalue\b|placeholder|src/.test(sketch));
  assert.ok(!sketch.includes("A".repeat(49)));
});

test("sketch respects depth, per-node child, and total-node caps", () => {
  const deep = el("i", {}, [el("i", {}, [el("i", {}, [el("i")])])]);
  const wide = el(
    "ul",
    {},
    Array.from({ length: 10 }, () => el("li")),
  );
  const root = el("main", {}, [deep, wide]);

  const sketch = buildDomSketch(root, { maxDepth: 2, maxChildren: 3, maxNodes: 50 });
  const lines = sketch.split("\n");

  // Depth cap: level-2 node with children is summarized, not descended into.
  assert.ok(lines.some((l) => /^ {4}i .*…1 deeper/.test(l) || /^ {4}i \(…1 deeper\)/.test(l)));
  // Child cap: 10 li → 3 rendered + a "+7 more" marker.
  assert.equal(lines.filter((l) => l.trim() === "li").length, 3);
  assert.ok(lines.some((l) => l.includes("… +7 more")));

  // Total budget cap.
  const tiny = buildDomSketch(wide, { maxNodes: 2, maxDepth: 3, maxChildren: 10 });
  assert.ok(tiny.split("\n").length <= 4);
  assert.ok(tiny.includes("sketch budget reached"));
});

test("describeElement never emits inline handler names", () => {
  const node = el("div", { onclick: "steal()", role: "button" });
  assert.equal(describeElement(node), 'div[role="button"]');
});

// ---- ancestor path + prefix resolution -------------------------------------

test("ancestor path uses stable hooks and resolves by deepest prefix", () => {
  const target = el("button", { "aria-label": "Retry" });
  const row = el("div", { class: "flex css-9f8e7d6c" }, [target]);
  const block = el("div", { "data-test-render-count": "4" }, [row]);
  const main = el("main", { class: "dframe-content" }, [block]);
  const body = el("body", {}, [main]);
  void body;

  const path = buildAncestorPath(target);
  assert.equal(path, "main.dframe-content > div[data-test-render-count] > div.flex > button");

  // Resolution: full path misses (anchor broke) → nearest surviving ancestor.
  const alive = new Map<string, string>([
    ["main.dframe-content", "main"],
    ["main.dframe-content > div[data-test-render-count]", "block"],
  ]);
  const hit = resolvePathPrefix(path, (sel) => alive.get(sel) ?? null);
  assert.equal(hit, "block");
  assert.equal(resolvePathPrefix("nope > nope", () => null), null);
});

// ---- prompt + reply parsing ------------------------------------------------

test("repair prompt embeds the sketch and the one-line ask", () => {
  const prompt = buildRepairPrompt({
    name: "retryButton",
    description: "per-answer retry/regenerate button",
    broken: 'button[aria-label="Retry"]',
    fallbacks: ['[data-testid="regenerate-button"]'],
    lastMatched: "3 days ago",
    sketch: "main\n  div[data-test-render-count]",
  });
  assert.ok(prompt.includes("<dom-sketch>"));
  assert.ok(prompt.includes("div[data-test-render-count]"));
  assert.ok(prompt.includes('button[aria-label="Retry"]'));
  assert.ok(prompt.includes("exactly one line"));
  assert.ok(prompt.includes("structure-only"));
});

test("parseSelectorReply handles fences, backticks, prose, and garbage", () => {
  const sel = 'button[aria-label="Retry response"]';
  assert.equal(parseSelectorReply(sel), sel);
  assert.equal(parseSelectorReply(`\`${sel}\``), sel);
  assert.equal(parseSelectorReply("```css\n" + sel + "\n```"), sel);
  assert.equal(parseSelectorReply(`Here is the fixed selector:\n\n${sel}\n\nHope that helps!`), sel);
  assert.equal(parseSelectorReply(""), null);
  assert.equal(parseSelectorReply("   \n  "), null);
  assert.equal(parseSelectorReply("x".repeat(2000)), null);
});
