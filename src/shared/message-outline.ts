/**
 * Message → outline-label helpers shared by the outline navigator and the
 * Conversation Atlas (features never import each other — the shared
 * extraction lives here instead).
 *
 * Pure functions over API message text — no DOM, no side effects. Originally the
 * outline feature's private helpers,
 * factored out when the atlas needed the same heading/label extraction.
 */

import { stripMarkdown } from "./text";

export interface Heading {
  /** Heading level 1–3 (`^#{1,3}` — deeper levels are treated as body text). */
  lvl: number;
  /** Markdown-stripped heading text (never empty). */
  txt: string;
}

/** A heading plus the body text that follows it (up to the next heading). */
export interface Section extends Heading {
  body: string;
}

/** Markdown → outline-label text: shared stripper + a residual
 *  marker sweep (lone fences/backticks that survive per-line stripping). */
export function mdLabel(line: string): string {
  return stripMarkdown(line)
    .replace(/[*`_#[\]]/g, "")
    .trim();
}

const HEADING_RE = /^(#{1,3})\s+(.+)$/;

/**
 * Split a message into heading-delimited sections. Text before the first
 * heading is not a section (it has no heading to label it). Headings that
 * markdown-strip to nothing are dropped along with their body.
 */
export function sectionsOf(text: string): Section[] {
  const out: Section[] = [];
  let current: { lvl: number; txt: string; body: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m) {
      const hashes = m[1];
      const rawTxt = m[2];
      if (current) {
        out.push({ lvl: current.lvl, txt: current.txt, body: current.body.join("\n") });
        current = null;
      }
      if (hashes && rawTxt) {
        const txt = mdLabel(rawTxt);
        if (txt) current = { lvl: hashes.length, txt, body: [] };
      }
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) {
    out.push({ lvl: current.lvl, txt: current.txt, body: current.body.join("\n") });
  }
  return out;
}

/** `^(#{1,3})\s+(.+)$` headings of a message, markdown-stripped, empties dropped. */
export function headingsOf(text: string): Heading[] {
  return sectionsOf(text).map(({ lvl, txt }) => ({ lvl, txt }));
}

/** Robust first-line label: first heading,
 *  else first line that strips to something and isn't the artifact
 *  placeholder, else the artifact fallback label. */
export function firstLabelOf(text: string): string {
  const firstHead = headingsOf(text)[0];
  if (firstHead) return firstHead.txt;
  const line = text
    .split("\n")
    .map((l) => mdLabel(l))
    .find((l) => l && !/^This block is not supported/.test(l));
  return line ?? "📄 (artifact / code block)";
}
