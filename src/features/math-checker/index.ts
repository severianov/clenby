/**
 * Math checker — Trust++. Conversation scope.
 *
 * Recomputes the simple arithmetic claims Claude states in answers
 * (`A op B = C` chains, `X% of Y = Z`) and marks the STATED RESULT with a
 * reversible inline highlight when it disagrees with the recomputed value.
 * Pure local computation — no network, no eval/Function, ever: claims are
 * tokenized by regex into numbers + operators and evaluated by a tiny
 * hand-rolled reducer.
 *
 * CONSERVATIVE BY DESIGN — the parser only accepts what is unambiguously an
 * arithmetic claim, and every guard errs toward "no flag":
 * - The full shape `N op N (op N)* (= | equals | is) N` is required; a bare
 *   `= N` anchor is what keeps versions, dates, ranges, and IDs out (they are
 *   never followed by "= <number>").
 * - Word-equals ("is"/"equals") additionally requires a chain with no `-`/`/`
 *   ops (ranges "10 - 20 is …" and rates would false-flag otherwise).
 * - Unspaced `-` or `/` with 3+ operands is skipped (dates: 2024-01-15,
 *   01/02/2024); any operand with a leading zero (05) is skipped (IDs/dates).
 * - Mixed currency symbols skip; `%` must be on ALL numbers (percent-point
 *   arithmetic) or handled via the explicit `X% of Y` form, else skip.
 * - A claim is OK if EITHER operator-precedence or left-to-right evaluation
 *   matches the stated value at the stated value's own precision (so
 *   "2/3 = 0.67" and "10/3 = 3" never flag). Only when every reading
 *   disagrees is the result marked.
 * - Magnitude > 1e12, > 6 operands, or division by zero → skip (never guess).
 *
 * DOM SAFETY: identical technique to highlights
 * — per-text-node spans wrapped in REVERSE offset order via
 * surroundContents; textContent is byte-identical before/after. Spans are NOT
 * stamped data-cc-owner (the runtime owner-sweep would delete the answer text
 * with them — same rule as mark.cc-hl); they are unwrapped on
 * toggle-off and in onCleanup. The ⚠ affordance is a CSS ::after pseudo —
 * pseudo content never appears in textContent/innerText, so dom-matcher
 * probes and folding stay exact.
 *
 * ENTRY POINTS (features never import each other): settings.mathCheckerOn
 * (gear "Trust" row + palette; default OFF), reacted to via
 * storage.onSettingsChanged.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";

const OWNER = "math-checker";
const SWEEP_MS = 1200;

// ---------------------------------------------------------------------------
// Claim scanning — pure text heuristics, exported for headless tests.
// ---------------------------------------------------------------------------

const MAX_OPERANDS = 6;
const MAX_MAGNITUDE = 1e12;

/** One number token: optional currency, integer with optional 3-digit comma
 *  groups, optional decimals, optional trailing %. */
const NUM_SRC = String.raw`[$€£]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?`;
/** Arithmetic operators (ASCII + the unicode variants Claude actually emits). */
const OP_SRC = String.raw`[+\-−*×xX·/÷]`;

/** Trailing guard after the stated result: reject when the claim actually
 *  continues — a digit tail (`1.5.6` versions, `1,5` euro decimals), a `%`
 *  or currency mark, a follow-on operator (`= 2 + 2`), or a word-form
 *  multiply leading to another number (`= 2 x 2`). A plain sentence period
 *  ("… = 154.") is NOT a rejection — pseudo-continuations must carry digits. */
const TAIL_GUARD = String.raw`(?!\.?\d|,\d|[%$€£]|[ \t]*[=+\-−*×/÷]|[ \t]*[xX·][ \t]*[\d$€£.])`;

/** `A op B (op C)* = R` — the one shape we recompute. The lookarounds keep us
 *  from starting/ending mid-number or chaining into a second `=`. */
const CLAIM_RE = new RegExp(
  String.raw`(?<![\d.,%$€£])` +
    String.raw`(${NUM_SRC}(?:[ \t]*${OP_SRC}[ \t]*${NUM_SRC})+)` +
    String.raw`(?:[ \t]*(=)[ \t]*|[ \t]+(equals|is)[ \t]+)` +
    String.raw`(${NUM_SRC})` +
    TAIL_GUARD,
  "g",
);

/** `X% of Y = Z` / `X% of Y is Z` — the one percentage form we recompute. */
const PCT_OF_RE = new RegExp(
  String.raw`(?<![\d.,%$€£])` +
    String.raw`(\d+(?:\.\d+)?)[ \t]*%[ \t]+of[ \t]+` +
    String.raw`([$€£]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)` +
    String.raw`(?:[ \t]*=[ \t]*|[ \t]+(?:equals|is)[ \t]+)` +
    String.raw`([$€£]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)` +
    TAIL_GUARD,
  "gi",
);

export interface MathHit {
  /** Offsets of the STATED RESULT token (the span that gets marked). */
  start: number;
  end: number;
  /** What the claim recomputes to. */
  computed: number;
  /** The full matched claim text (for the title tooltip). */
  claim: string;
}

interface Token {
  raw: string;
  value: number;
  currency: string;
  pct: boolean;
  /** Leading zero like "05" — date/ID smell, poisons the claim. */
  leadingZero: boolean;
}

function parseNumToken(raw: string): Token {
  const currency = /^[$€£]/.exec(raw)?.[0] ?? "";
  const pct = raw.endsWith("%");
  const core = raw.replace(/^[$€£]/, "").replace(/%$/, "");
  const digits = core.replace(/,/g, "");
  return {
    raw,
    value: Number.parseFloat(digits),
    currency,
    pct,
    leadingZero: /^0\d/.test(core),
  };
}

type Op = "+" | "-" | "*" | "/";

function normalizeOp(raw: string): Op {
  if (raw === "+" ) return "+";
  if (raw === "-" || raw === "−") return "-";
  if (raw === "/" || raw === "÷") return "/";
  return "*"; // * × x X ·
}

/** Left-to-right evaluation. Null on division by zero. */
function evalLtr(nums: number[], ops: Op[]): number | null {
  let acc = nums[0] ?? 0;
  for (let i = 0; i < ops.length; i++) {
    const b = nums[i + 1] ?? 0;
    const op = ops[i] ?? "+";
    if (op === "/" && b === 0) return null;
    acc = op === "+" ? acc + b : op === "-" ? acc - b : op === "*" ? acc * b : acc / b;
  }
  return acc;
}

/** Standard-precedence evaluation (mul/div before add/sub). Null on ÷0. */
function evalPrecedence(nums: number[], ops: Op[]): number | null {
  const vals = [...nums];
  const rest = [...ops];
  for (let i = 0; i < rest.length; ) {
    const op = rest[i];
    if (op === "*" || op === "/") {
      const a = vals[i] ?? 0;
      const b = vals[i + 1] ?? 0;
      if (op === "/" && b === 0) return null;
      vals.splice(i, 2, op === "*" ? a * b : a / b);
      rest.splice(i, 1);
    } else {
      i++;
    }
  }
  return evalLtr(vals, rest);
}

/** Does `computed` agree with the stated token AT THE STATED PRECISION?
 *  "2/3 = 0.67" (2 decimals) and "10/3 = 3" (0 decimals) both agree. */
function statedMatches(computed: number, statedRaw: string, statedValue: number): boolean {
  if (computed === statedValue) return true;
  const core = statedRaw.replace(/^[$€£]/, "").replace(/%$/, "").replace(/,/g, "");
  const dot = core.indexOf(".");
  const decimals = dot >= 0 ? core.length - dot - 1 : 0;
  const eps = 10 ** -decimals / 2 + 1e-9;
  return Math.abs(computed - statedValue) <= eps;
}

/** Tokenize a matched LHS chain; null when anything looks non-arithmetic. */
function tokenizeChain(
  lhs: string,
): { nums: Token[]; ops: Op[]; tightMinusOrSlash: boolean } | null {
  const numRe = new RegExp(NUM_SRC, "y");
  const opRe = new RegExp(`[ \\t]*(${OP_SRC})[ \\t]*`, "y");
  const nums: Token[] = [];
  const ops: Op[] = [];
  let tightMinusOrSlash = false;
  let pos = 0;
  for (;;) {
    numRe.lastIndex = pos;
    const nm = numRe.exec(lhs);
    if (!nm || nm.index !== pos) return null;
    nums.push(parseNumToken(nm[0]));
    pos = numRe.lastIndex;
    if (pos >= lhs.length) break;
    opRe.lastIndex = pos;
    const om = opRe.exec(lhs);
    if (!om || om.index !== pos) return null;
    const opRaw = om[1] ?? "+";
    if ((opRaw === "-" || opRaw === "−" || opRaw === "/" || opRaw === "÷") && om[0] === opRaw) {
      tightMinusOrSlash = true; // unspaced — date/range/version smell
    }
    ops.push(normalizeOp(opRaw));
    pos = opRe.lastIndex;
  }
  if (nums.length !== ops.length + 1) return null;
  return { nums, ops, tightMinusOrSlash };
}

/**
 * Scan one text run for wrong arithmetic claims. Returns ONLY disagreements —
 * a claim that parses and checks out produces nothing.
 */
export function scanMathClaims(text: string): MathHit[] {
  const hits: MathHit[] = [];
  const claimed: Array<[number, number]> = [];

  // `X% of Y` first — the general chain regex can't see the "of", and the two
  // shapes never produce overlapping RESULT tokens for the same claim.
  for (const m of text.matchAll(PCT_OF_RE)) {
    const pctTok = m[1] ?? "";
    const baseTok = parseNumToken(m[2] ?? "");
    const statedTok = parseNumToken(m[3] ?? "");
    if (baseTok.leadingZero || statedTok.leadingZero) continue;
    if (baseTok.currency && statedTok.currency && baseTok.currency !== statedTok.currency) continue;
    const pct = Number.parseFloat(pctTok);
    const computed = (pct / 100) * baseTok.value;
    if (!Number.isFinite(computed) || Math.abs(computed) > MAX_MAGNITUDE) continue;
    if (statedMatches(computed, statedTok.raw, statedTok.value)) continue;
    const start = m.index + m[0].length - statedTok.raw.length;
    hits.push({ start, end: start + statedTok.raw.length, computed, claim: m[0] });
    claimed.push([m.index, m.index + m[0].length]);
  }

  for (const m of text.matchAll(CLAIM_RE)) {
    const mStart = m.index;
    const mEnd = m.index + m[0].length;
    if (claimed.some(([s, e]) => mStart < e && mEnd > s)) continue;

    // Hex literals: "0x10 = 16" would tokenize as 0 × 10 — never a claim.
    // ([^\d] guard keeps genuine products like "10x5" matchable.)
    if (/(?:^|[^\d])0[xX]\d/.test(m[0])) continue;

    const lhs = m[1] ?? "";
    const isWordEquals = m[2] !== "=";
    const statedTok = parseNumToken(m[4] ?? "");
    const chain = tokenizeChain(lhs);
    if (!chain) continue;
    const all = [...chain.nums, statedTok];

    // ---- guards (each one errs toward "no flag") --------------------------
    if (all.some((t) => t.leadingZero)) continue; // dates/IDs (05, 01, …)
    if (chain.nums.length > MAX_OPERANDS) continue;
    if (all.some((t) => !Number.isFinite(t.value) || Math.abs(t.value) > MAX_MAGNITUDE)) continue;
    // Unspaced -/÷ with 3+ operands: 2024-01-15, 01/02/2024 shapes.
    if (chain.tightMinusOrSlash && chain.nums.length > 2) continue;
    // "is"/"equals" + minus/divide reads as ranges/rates too often.
    if (isWordEquals && chain.ops.some((op) => op === "-" || op === "/")) continue;
    // Mixed currency symbols → not one computation.
    const currencies = new Set(all.map((t) => t.currency).filter((c) => c !== ""));
    if (currencies.size > 1) continue;
    // `%` must be on all numbers (percent-point arithmetic) or on none.
    const pctCount = all.filter((t) => t.pct).length;
    if (pctCount !== 0 && pctCount !== all.length) continue;

    const nums = chain.nums.map((t) => t.value);
    const prec = evalPrecedence(nums, chain.ops);
    const ltr = evalLtr(nums, chain.ops);
    if (prec === null || ltr === null) continue; // ÷0 — never guess
    // OK under EITHER reading → not a flag.
    if (statedMatches(prec, statedTok.raw, statedTok.value)) continue;
    if (statedMatches(ltr, statedTok.raw, statedTok.value)) continue;

    const start = mStart + m[0].length - statedTok.raw.length;
    hits.push({ start, end: start + statedTok.raw.length, computed: prec, claim: m[0] });
    claimed.push([mStart, mEnd]);
  }

  return hits.sort((a, b) => a.start - b.start);
}

/** Human formatting for the recomputed value (≤6 decimals, no dangling .0). */
export function formatComputed(n: number): string {
  const rounded = Math.round(n * 1e6) / 1e6;
  return String(rounded);
}

// ---------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------

export const mathChecker: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "conversation",

  async mount(ctx: FeatureContext) {
    let on = false;
    let generating = false;
    /** el → textContent.length at apply time (wrapping never changes it, so a
     *  drift means claude re-rendered/extended the answer → re-wrap). */
    const applied = new WeakMap<HTMLElement, number>();

    const answers = (): HTMLElement[] =>
      ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);

    // ---- wrapping (reverse-order text-node technique) ----------------------
    // `pre` skipped: arithmetic inside code blocks is program text, not a
    // claim. Our own spans skipped for idempotence.
    const walkerFilter: NodeFilter = {
      acceptNode: (n: Node) =>
        n.parentElement?.closest(
          "[data-cc-owner], span.cc-mc-bad, .cc-gutter, .cc-foldhead, .cc-meta-area, pre",
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    };

    const applyTo = (el: HTMLElement): void => {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, walkerFilter);
      const nodes: Text[] = [];
      while (tw.nextNode()) nodes.push(tw.currentNode as Text);
      for (const node of nodes) {
        const text = node.textContent ?? "";
        if (text.length < 5) continue; // shortest claim is "1+1=2"
        const hits = scanMathClaims(text);
        // REVERSE order keeps earlier offsets valid while surroundContents
        // splits the node (the original Text keeps the leading run).
        for (const h of [...hits].reverse()) {
          const r = document.createRange();
          r.setStart(node, h.start);
          r.setEnd(node, h.end);
          const span = document.createElement("span");
          // Deliberately unstamped — see the header comment.
          span.className = "cc-mc-bad";
          span.title = `Companion math check: “${h.claim}” recomputes to ${formatComputed(
            h.computed,
          )} — double-check this figure`;
          try {
            r.surroundContents(span);
          } catch {
            /* partial-element edge — skip this claim, keep the rest */
          }
        }
      }
    };

    const unwrapIn = (scope: ParentNode): void => {
      for (const s of scope.querySelectorAll<HTMLElement>("span.cc-mc-bad")) {
        const parent = s.parentNode;
        s.replaceWith(...s.childNodes);
        parent?.normalize(); // merge the splits back — leave no trace
      }
    };

    // ---- the one reconcile path ---------------------------------------------
    const sweep = (): void => {
      // Streaming text grows every tick — wrapping then would churn; the
      // post-generation conversation:updated re-runs us over settled text.
      if (generating) return;
      for (const el of answers()) {
        const len = (el.textContent ?? "").length;
        const appliedLen = applied.get(el);
        if (on && appliedLen !== len) {
          if (appliedLen !== undefined) unwrapIn(el); // content drifted
          applyTo(el);
          applied.set(el, (el.textContent ?? "").length); // === len (invariant)
        } else if (!on && appliedLen !== undefined) {
          unwrapIn(el);
          applied.delete(el);
        }
      }
    };

    // ---- entry point: the global switch (gear "Trust" row / palette) ------
    const settings = await ctx.storage.getSettings();
    if (ctx.signal.aborted) return;
    on = settings.mathCheckerOn;

    ctx.onCleanup(
      ctx.storage.onSettingsChanged((s) => {
        if (s.mathCheckerOn === on) return;
        on = s.mathCheckerOn;
        sweep();
      }),
    );

    // ---- maintenance -------------------------------------------------------
    ctx.on("generation:start", () => {
      generating = true;
    });
    ctx.on("generation:end", () => {
      generating = false;
    });
    ctx.setInterval(sweep, SWEEP_MS);
    ctx.on("conversation:updated", sweep);
    sweep();

    // ---- teardown: unwrap everything (spans are unstamped by design) -------
    ctx.onCleanup(() => unwrapIn(document));
  },
};
