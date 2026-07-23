/**
 * Text helpers shared across features — clipping, normalization, markdown
 * stripping, word counting, and companion-char stripping for DOM↔API matching.
 *
 * Pure functions, no DOM, no side effects — trivially testable.
 */

/** Characters the companion injects into claude's DOM that must be stripped
 *  before probing rendered text against API bodies — otherwise DOM↔API
 *  matching misses. */
const COMPANION_CHARS = /[─−📌⋯✕🖍]/gu;

/** Collapse whitespace and trim. */
export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/** Strip companion-injected glyphs, then normalize — the canonical form used
 *  for text matching between rendered nodes and API message text. */
export function stripForMatch(input: string): string {
  return normalizeWhitespace(input.replace(COMPANION_CHARS, ""));
}

/** Very small markdown → plain-text reducer for outline labels. Removes the
 *  common inline/block markers without pulling in a parser. */
export function stripMarkdown(input: string): string {
  let s = input;
  s = s.replace(/```[\s\S]*?```/g, " "); // fenced code
  s = s.replace(/`([^`]+)`/g, "$1"); // inline code
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links → text
  s = s.replace(/^#{1,6}\s+/gm, ""); // headings
  s = s.replace(/^\s{0,3}>\s?/gm, ""); // blockquotes
  s = s.replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, ""); // list markers
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2"); // bold
  s = s.replace(/(\*|_)(.*?)\1/g, "$2"); // italic
  s = s.replace(/~~(.*?)~~/g, "$1"); // strikethrough
  return normalizeWhitespace(s);
}

/** Artifact placeholder fences the web app emits for unsupported blocks. */
const ARTIFACT_FENCE_RE = /```[^`]*?This block is not supported[^`]*?```/g;
const ARTIFACT_PLACEHOLDER = "*[artifact / code block omitted — open in claude.ai]*";

/** Canonical cleanup for exported message bodies (export + outline pinned
 *  export): swap artifact-placeholder fences for a readable omission note,
 *  leave every real code fence intact. */
export function cleanExportBody(text: string): string {
  return text.replace(ARTIFACT_FENCE_RE, ARTIFACT_PLACEHOLDER).trim();
}

/** Clip to `max` chars on a word boundary, appending an ellipsis when cut. */
export function clip(input: string, max: number): string {
  const s = normalizeWhitespace(input);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** Word count over normalized text (used by the draft counter). */
export function wordCount(input: string): number {
  const s = normalizeWhitespace(input);
  return s.length === 0 ? 0 : s.split(" ").length;
}

/**
 * The verified DOM↔API probe: sample 40-char
 * windows at 0%, 40%, and 70% of the (companion-stripped) rendered text. First-
 * N-chars matching FAILS on answers opening with tool blocks / artifact
 * placeholders, so we take samples from across the body instead.
 */
export function probeSamples(rendered: string, size = 40): string[] {
  const s = stripForMatch(rendered);
  if (s.length === 0) return [];
  if (s.length <= size) return [s];
  const offsets = [0, 0.4, 0.7];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const frac of offsets) {
    const start = Math.min(Math.floor(s.length * frac), s.length - size);
    const sample = s.slice(Math.max(0, start), Math.max(0, start) + size);
    if (sample && !seen.has(sample)) {
      seen.add(sample);
      out.push(sample);
    }
  }
  return out;
}

/** True when any probe sample from `rendered` is a substring of `apiText`. */
export function textMatches(rendered: string, apiText: string): boolean {
  const haystack = stripForMatch(apiText);
  if (!haystack) return false;
  return probeSamples(rendered).some((s) => haystack.includes(s));
}

/** Estimated token count for the context gauge (chars / 4, the verified
 *  heuristic over the FULL API conversation, not just rendered messages). */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}
