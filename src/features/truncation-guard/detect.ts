/**
 * Truncation detection over API message text — pure functions, no DOM
 * (trivially testable, same policy as shared/text.ts).
 *
 * Deliberately CONSERVATIVE: a false "looks cut off" nags the user on every
 * completed answer, so each heuristic prefers missing a truncation over
 * flagging a finished message. The affordance is dismissible per answer, which
 * covers the residual false positives.
 */

export type TruncationReason = "fence" | "dangling";

/** A fenced-code delimiter line (CommonMark: up to 3 leading spaces). */
const FENCE_LINE_RE = /^ {0,3}(?:```|~~~)/;

/** Count fence delimiter lines. An odd count means a fence never closed —
 *  claude.ai's renderer then paints the rest of the message as one giant
 *  code block, the classic mid-code cutoff symptom. */
export function countFenceLines(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (FENCE_LINE_RE.test(line)) n++;
  }
  return n;
}

/** Endings that almost never close a finished thought. */
const DANGLING_TAIL_RE = /[,;:(\[{–—-]$/;

/** Connectives/articles a sentence essentially cannot end on. Word-boundary
 *  matched against the last word (lowercased). */
const DANGLING_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "to",
  "of",
  "with",
  "in",
  "for",
  "on",
  "at",
  "by",
  "from",
  "into",
  "onto",
  "as",
  "if",
  "when",
  "while",
  "because",
  "so",
  "that",
  "which",
  "is",
  "are",
  "was",
  "were",
]);

/** Minimum length of the final line before the "prose without terminal
 *  punctuation" rule may fire — short tails are usually headings, list items
 *  or one-word answers, all legitimately unpunctuated. */
const PROSE_LINE_MIN = 80;

/**
 * Detect a cut-off answer from its API text.
 *
 * - "fence"    — odd number of code-fence delimiter lines (unclosed block).
 * - "dangling" — the text ends mid-sentence: a hanging connective/article, a
 *   comma/colon/open-bracket tail, or a long prose line with no terminal
 *   punctuation at all.
 *
 * Returns null for anything that plausibly finished. Manual stop-button stops
 * are a separate signal owned by the feature (DOM fact, not a text fact).
 */
export function detectTruncation(text: string): TruncationReason | null {
  const t = text.replace(/\s+$/, "");
  if (!t) return null;

  if (countFenceLines(t) % 2 === 1) return "fence";

  // ---- dangling-ending heuristics (prose only, conservative) ----
  if (DANGLING_TAIL_RE.test(t)) return "dangling";

  const lastWord = (/([\p{L}\p{N}'’-]+)$/u.exec(t)?.[1] ?? "").toLowerCase();
  if (lastWord && DANGLING_WORDS.has(lastWord)) return "dangling";

  const lastLine = t.slice(t.lastIndexOf("\n") + 1).trim();
  if (
    lastLine.length >= PROSE_LINE_MIN &&
    /\p{Ll}$/u.test(lastLine) && // ends on a lowercase letter…
    !/^ {0,3}(?:[-*+]|\d+[.)])\s/.test(lastLine) && // …not a list item
    !lastLine.startsWith("#") && // …not a heading
    !lastLine.includes("|") // …not a table row
  ) {
    return "dangling";
  }

  return null;
}

/** Human label for the affordance, per reason. */
export function reasonLabel(reason: TruncationReason | "stopped"): string {
  switch (reason) {
    case "fence":
      return "unclosed code block";
    case "dangling":
      return "ends mid-sentence";
    case "stopped":
      return "stopped early";
  }
}
