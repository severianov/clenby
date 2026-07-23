/**
 * Repair-flow evidence builders — PURE functions, no DOM globals, no imports.
 * Unit-tested in tests/repair-sketch.test.ts (node --test, no browser).
 *
 * Privacy invariant (scope doc §4.1 / §6.4): NOTHING that can carry
 * conversation text ever enters a sketch or prompt. Enforced structurally:
 * - text content is never read (the input interfaces don't even expose it);
 * - attribute VALUES are emitted only for a small structural allowlist
 *   ({@link VALUE_ATTRS}), and even those are dropped when long or
 *   multi-line; every other attribute contributes its NAME only;
 * - content-bearing attributes ({@link DROPPED_ATTRS}: title/alt/value/
 *   placeholder/href/src/style/…) are dropped entirely, not even named;
 * - hashed/utility class-name noise is collapsed to "…" so only stable,
 *   selector-usable class shapes survive.
 *
 * The unit tests are the enforcement mechanism for this invariant — extend
 * them when touching the allowlists.
 */

// ---------------------------------------------------------------------------
// Input shapes — structural subsets of DOM Element, so real Elements satisfy
// them directly while tests construct plain objects.
// ---------------------------------------------------------------------------

/** What the sketch walker needs from a node. `Element` satisfies this. */
export interface SketchableElement {
  readonly tagName: string;
  getAttributeNames(): string[];
  getAttribute(name: string): string | null;
  readonly children: ArrayLike<SketchableElement>;
}

/** What the ancestor-path builder needs. `Element` satisfies this. */
export interface PathableElement {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  readonly parentElement: PathableElement | null;
}

// ---------------------------------------------------------------------------
// Attribute policy
// ---------------------------------------------------------------------------

/** Attributes whose VALUES are structural and safe to include (still guarded
 *  by {@link MAX_ATTR_VALUE_LEN} + single-line). Everything else is name-only. */
const VALUE_ATTRS = new Set([
  "data-testid",
  "data-test-render-count",
  "role",
  "type",
  "dir",
  "contenteditable",
  "aria-label",
  "aria-expanded",
  "aria-haspopup",
  "aria-hidden",
  "aria-live",
  "aria-pressed",
  "aria-checked",
  "aria-selected",
  "aria-disabled",
]);

/** Attributes that can carry page/user content — dropped entirely (not even
 *  the name appears, so their presence leaks nothing). */
const DROPPED_ATTRS = new Set([
  "title",
  "alt",
  "value",
  "placeholder",
  "href",
  "src",
  "srcset",
  "srcdoc",
  "style",
  "d",
  "poster",
  "content",
  "download",
  "action",
  "cite",
  "data",
  "aria-description",
  "aria-valuetext",
]);

/** aria-label & co. above this length (or multi-line) fall back to name-only —
 *  a UI control label is short; anything longer might be content. */
const MAX_ATTR_VALUE_LEN = 48;

const MAX_ATTRS_PER_NODE = 6;
const MAX_CLASSES_PER_NODE = 8;
const MAX_SELECTOR_REPLY_LEN = 1024;

function escapeAttrValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Class shapes — keep stable tokens, collapse hashed/utility noise to "…"
// ---------------------------------------------------------------------------

/**
 * True when a class token is stable enough to be useful in a selector:
 * plain [a-z0-9-] identifier, not suspiciously long, and not hash-shaped.
 * `bg-bg-300` / `font-claude-response` / `max-w-3xl` pass; `css-1q2w3e4r`,
 * tailwind variants (`hover:x`), arbitrary values (`bg-[url(…)]`), and
 * long digit runs collapse.
 */
export function isStableClassToken(token: string): boolean {
  if (token.length === 0 || token.length > 30) return false;
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(token)) return false;
  if (/\d{5,}/.test(token)) return false; // long digit runs are build hashes
  if (/^[a-z]{0,4}-?[0-9a-f]{6,}$/i.test(token) && /\d/.test(token)) return false; // css-1a2b3c4d
  return true;
}

/**
 * Class attribute → sanitized token list. Unstable tokens collapse to "…"
 * (consecutive collapses dedupe); capped at {@link MAX_CLASSES_PER_NODE}.
 */
export function sanitizeClassList(classAttr: string | null): string[] {
  if (!classAttr) return [];
  const out: string[] = [];
  for (const token of classAttr.split(/\s+/)) {
    if (token.length === 0) continue;
    if (isStableClassToken(token)) {
      out.push(token);
    } else if (out[out.length - 1] !== "…") {
      out.push("…");
    }
    if (out.length >= MAX_CLASSES_PER_NODE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Node descriptor + sketch walker
// ---------------------------------------------------------------------------

/** One node as `tag[attr="v"][attr].class.…` — the sketch line body. */
export function describeElement(el: SketchableElement): string {
  const parts: string[] = [];
  for (const raw of el.getAttributeNames()) {
    if (parts.length >= MAX_ATTRS_PER_NODE) break;
    const name = raw.toLowerCase();
    if (name === "class" || name === "id") continue; // classes handled below; ids are build-random
    if (DROPPED_ATTRS.has(name)) continue;
    if (name.startsWith("on")) continue; // inline handlers — never
    const v = VALUE_ATTRS.has(name) ? el.getAttribute(raw) : null;
    if (v !== null && v.length <= MAX_ATTR_VALUE_LEN && !/[\n\r]/.test(v)) {
      parts.push(`[${name}="${escapeAttrValue(v)}"]`);
    } else {
      parts.push(`[${name}]`);
    }
  }
  const classes = sanitizeClassList(el.getAttribute("class"));
  return (
    el.tagName.toLowerCase() +
    parts.join("") +
    classes.map((c) => `.${c}`).join("")
  );
}

export interface SketchOptions {
  /** Levels below the root to descend (root is depth 0). */
  maxDepth?: number;
  /** Children rendered per node before a `… +N more` marker. */
  maxChildren?: number;
  /** Total node budget for the whole sketch. */
  maxNodes?: number;
}

const SKETCH_DEFAULTS: Required<SketchOptions> = {
  maxDepth: 5,
  maxChildren: 6,
  maxNodes: 150,
};

/**
 * Structure-only sketch of a DOM region: an indented tree of
 * {@link describeElement} lines with depth/breadth/total caps so the output
 * stays prompt-sized on any page. Never reads text content.
 */
export function buildDomSketch(root: SketchableElement, opts: SketchOptions = {}): string {
  const o = { ...SKETCH_DEFAULTS, ...opts };
  const lines: string[] = [];
  const budget = { nodes: o.maxNodes };

  const walk = (el: SketchableElement, depth: number): void => {
    if (budget.nodes <= 0) return;
    budget.nodes--;
    const indent = "  ".repeat(depth);
    const childCount = el.children.length;
    if (depth >= o.maxDepth && childCount > 0) {
      lines.push(`${indent}${describeElement(el)} (…${childCount} deeper)`);
      return;
    }
    lines.push(indent + describeElement(el));
    const shown = Math.min(childCount, o.maxChildren);
    for (let i = 0; i < shown; i++) {
      if (budget.nodes <= 0) {
        lines.push(`${"  ".repeat(depth + 1)}… (sketch budget reached)`);
        return;
      }
      const child = el.children[i];
      if (child) walk(child, depth + 1);
    }
    if (childCount > shown) {
      lines.push(`${"  ".repeat(depth + 1)}… +${childCount - shown} more`);
    }
  };

  walk(root, 0);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Ancestor-path evidence — remembered while an anchor still matches, so a
// now-broken anchor still points at a region to sketch.
// ---------------------------------------------------------------------------

const MAX_PATH_SEGMENTS = 8;
const SAFE_TESTID_RE = /^[\w-]{1,48}$/;

function pathSegment(el: PathableElement): string {
  let seg = el.tagName.toLowerCase();
  const testid = el.getAttribute("data-testid");
  if (testid !== null && SAFE_TESTID_RE.test(testid)) {
    return `${seg}[data-testid="${testid}"]`;
  }
  if (el.getAttribute("data-test-render-count") !== null) {
    return `${seg}[data-test-render-count]`;
  }
  const classes = sanitizeClassList(el.getAttribute("class"))
    .filter((c) => c !== "…")
    .slice(0, 2);
  seg += classes.map((c) => `.${c}`).join("");
  return seg;
}

/**
 * Structural ancestor path of a matched element (` > `-joined segments,
 * nearest {@link MAX_PATH_SEGMENTS} levels, html/body excluded). Each segment
 * uses only stable hooks (tag, data-testid, stable classes) — same privacy
 * policy as the sketch. Resolvable later via {@link resolvePathPrefix}.
 */
export function buildAncestorPath(el: PathableElement): string {
  const segs: string[] = [];
  let cur: PathableElement | null = el;
  while (cur !== null && segs.length < MAX_PATH_SEGMENTS) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "html" || tag === "body") break;
    segs.unshift(pathSegment(cur));
    cur = cur.parentElement;
  }
  return segs.join(" > ");
}

/**
 * Resolve an ancestor path against the live page: try the full path, then
 * progressively shorter prefixes, returning the DEEPEST still-matching
 * element — the nearest surviving ancestor of a now-broken anchor. The query
 * function is injected (pure module; also lets callers try/catch).
 */
export function resolvePathPrefix<T>(
  path: string,
  query: (selector: string) => T | null,
): T | null {
  const segs = path.split(" > ").filter((s) => s.length > 0);
  for (let end = segs.length; end >= 1; end--) {
    const hit = query(segs.slice(0, end).join(" > "));
    if (hit !== null) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The repair prompt + answer parsing
// ---------------------------------------------------------------------------

export interface RepairPromptInput {
  /** Anchor name, e.g. "retryButton". */
  name: string;
  /** Human description from the selector registry. */
  description: string;
  /** The selector that stopped matching (current effective primary). */
  broken: string;
  /** Shipped fallbacks that also miss. */
  fallbacks: readonly string[];
  /** Human phrase, e.g. "3 days ago · 212× this session" — or null. */
  lastMatched: string | null;
  /** Output of {@link buildDomSketch}. */
  sketch: string;
}

/** The ready-made prompt the user carries into a claude.ai chat (session
 *  flow) or that the background worker sends to the API (opt-in flow). */
export function buildRepairPrompt(i: RepairPromptInput): string {
  const fallbackLine =
    i.fallbacks.length > 0 ? i.fallbacks.join("  ·  ") : "none";
  return [
    "I'm repairing a broken CSS selector for a browser extension that anchors its UI onto claude.ai. The page's DOM changed and the selector no longer matches anything.",
    "",
    `Anchor name: ${i.name}`,
    `What it targets: ${i.description}`,
    `Broken selector: ${i.broken}`,
    `Fallbacks that also match nothing: ${fallbackLine}`,
    ...(i.lastMatched ? [`Last seen matching: ${i.lastMatched}`] : []),
    "",
    'Below is a structure-only sketch of the DOM region where it should match. It contains tag names, attribute names, and class patterns only — text content and content-bearing attribute values are stripped, and "…" marks collapsed hashed class names.',
    "",
    "<dom-sketch>",
    i.sketch,
    "</dom-sketch>",
    "",
    "Task: propose ONE replacement CSS selector that matches exactly the element(s) described above in this DOM. Prefer stable hooks (data-testid, aria attributes, semantic structure) over hashed utility classes.",
    "",
    "Reply with exactly one line containing only the CSS selector — no explanation, no code fences, no quotes.",
  ].join("\n");
}

/**
 * Extract the selector from a pasted (or API) model reply. Tolerates code
 * fences, backticks, quotes, and stray prose lines; returns null when no
 * plausible selector line is found. The result is UNTRUSTED — callers must
 * still run it through write-validation + the live probe.
 */
export function parseSelectorReply(raw: string): string | null {
  let text = raw.trim();
  if (text.length === 0) return null;
  const fenced = text.match(/```[a-zA-Z]*\r?\n?([\s\S]*?)```/);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (line.length === 0) continue;
    line = line
      .replace(/^`+/, "")
      .replace(/`+$/, "")
      .replace(/^["']/, "")
      .replace(/["']$/, "")
      .trim();
    if (line.length === 0) continue;
    // Prose, not a selector: leading chatter or a lead-in ending with ":".
    if (/^(here|the |this |sure|i |it |ok|note)/i.test(line) || line.endsWith(":")) continue;
    if (line.length > MAX_SELECTOR_REPLY_LEN) return null;
    return line;
  }
  return null;
}
