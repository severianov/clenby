/**
 * Fence analysis + display-only repair over API message text — pure
 * functions, no DOM (trivially testable, same policy as shared/text.ts).
 *
 * The runaway symptom: an assistant message with an ODD number of code-fence
 * delimiter lines has one fence that never closes, and markdown renderers
 * (claude.ai's included) then paint everything after it as one giant code
 * block. The most useful repair for READING is to treat that unmatched
 * delimiter as plain text so the swallowed content renders as the markdown it
 * was written as. That is a heuristic — the tail could genuinely be code cut
 * off mid-stream — so the repair is display-only, clearly labeled, reversible,
 * and never touches the stored message (index.ts owns those guarantees).
 */

/** A fenced-code delimiter line (CommonMark: up to 3 leading spaces). */
const FENCE_LINE_RE = /^ {0,3}(```|~~~)/;

export interface FenceScan {
  /** Total fence delimiter lines. */
  count: number;
  /** Line index of the delimiter left unmatched at EOF, or null when
   *  balanced. With a simple open/close toggle this is always the LAST
   *  delimiter line when `count` is odd. */
  unmatchedLine: number | null;
}

/** Scan fence delimiter lines with a plain open/close toggle (matching how
 *  renderers treat any delimiter line while a block is open as its closer). */
export function scanFences(text: string): FenceScan {
  const lines = text.split("\n");
  let count = 0;
  let openAt: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE_LINE_RE.test(lines[i] ?? "")) continue;
    count++;
    openAt = openAt === null ? i : null;
  }
  return { count, unmatchedLine: openAt };
}

export interface FenceSplit {
  /** Markdown before the unmatched delimiter (fences balanced). */
  before: string;
  /** The unmatched delimiter line itself (shown literally in the re-render). */
  fenceLine: string;
  /** Markdown after it — the content the broken fence swallowed. */
  after: string;
}

/** Split the message at its unmatched fence, or null when fences balance. */
export function splitAtUnmatchedFence(text: string): FenceSplit | null {
  const { unmatchedLine } = scanFences(text);
  if (unmatchedLine === null) return null;
  const lines = text.split("\n");
  return {
    before: lines.slice(0, unmatchedLine).join("\n"),
    fenceLine: lines[unmatchedLine] ?? "```",
    after: lines.slice(unmatchedLine + 1).join("\n"),
  };
}

/** The corrected markdown offered for copy: the unmatched delimiter line is
 *  dropped, everything else byte-identical. */
export function correctedMarkdown(text: string): string {
  const split = splitAtUnmatchedFence(text);
  if (!split) return text;
  return (split.before ? split.before + "\n" : "") + split.after;
}
