/**
 * Fence-fixer markdown renderer — API message text → companion-owned DOM.
 *
 * Purpose-built for the display-only repair panel (NOT a general parser),
 * following the mini-window/markdown.ts pattern — deliberately its OWN copy:
 * features never import each other, and the mini-window renderer is that
 * feature's private module. Scope here is the read-back subset: headings,
 * paragraphs, `inline code`, fenced code blocks, ordered/bullet lists,
 * blockquotes, hr, links, bold/italic/strikethrough.
 *
 * Safety: every piece of MESSAGE content enters the DOM via textContent /
 * createTextNode — never innerHTML. Links render only for http(s) URLs;
 * anything else falls back to plain text. All styling comes from
 * companion.css classes reading var(--cc-*) — zero inline styles.
 */

import { ownedEl } from "@/ui/root";

const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const FENCE_OPEN_RE = /^ {0,3}(?:```|~~~)/;
const FENCE_CLOSE_RE = /^ {0,3}(?:```|~~~)\s*\S*\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

/** Render markdown into a fresh `.cc-ff-md` container. */
export function renderMarkdown(owner: string, md: string): HTMLDivElement {
  const root = ownedEl("div", { owner, className: "cc-ff-md" });
  const lines = md.split("\n");
  let i = 0;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length === 0) return;
    const p = ownedEl("p", { owner });
    appendInline(owner, p, para.join(" "));
    root.append(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (FENCE_OPEN_RE.test(line)) {
      flushPara();
      i++;
      const code: string[] = [];
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // past the closing fence (or EOF on an unclosed fence)
      const pre = ownedEl("pre", { owner });
      pre.append(ownedEl("code", { owner, text: code.join("\n") }));
      root.append(pre);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      const lvl = Math.min((h[1] ?? "#").length, 4);
      const el = ownedEl(`h${lvl}` as "h1" | "h2" | "h3" | "h4", { owner });
      appendInline(owner, el, h[2] ?? "");
      root.append(el);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      flushPara();
      root.append(ownedEl("hr", { owner }));
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length) {
        const m = QUOTE_RE.exec(lines[i] ?? "");
        if (!m) break;
        quoted.push(m[1] ?? "");
        i++;
      }
      const bq = ownedEl("blockquote", { owner });
      const p = ownedEl("p", { owner });
      appendInline(owner, p, quoted.join(" ").trim());
      bq.append(p);
      root.append(bq);
      continue;
    }

    if (OL_RE.test(line)) {
      flushPara();
      const ol = ownedEl("ol", { owner });
      while (i < lines.length) {
        const m = OL_RE.exec(lines[i] ?? "");
        if (!m) break;
        const li = ownedEl("li", { owner });
        appendInline(owner, li, m[1] ?? "");
        ol.append(li);
        i++;
      }
      root.append(ol);
      continue;
    }

    if (UL_RE.test(line)) {
      flushPara();
      const ul = ownedEl("ul", { owner });
      while (i < lines.length) {
        const m = UL_RE.exec(lines[i] ?? "");
        if (!m) break;
        const li = ownedEl("li", { owner });
        appendInline(owner, li, m[1] ?? "");
        ul.append(li);
        i++;
      }
      root.append(ul);
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return root;
}

// ---------------------------------------------------------------------------
// Inline markdown → nodes
// ---------------------------------------------------------------------------

type InlineKind = "code" | "bold" | "em" | "del" | "img" | "link";

/** Order = tie-break priority at equal match index (code always wins; `**`
 *  before `*` so bold is never half-eaten by italic). */
const INLINE_PATTERNS: ReadonlyArray<{ kind: InlineKind; re: RegExp }> = [
  { kind: "code", re: /`([^`]+)`/ },
  { kind: "bold", re: /\*\*([^*]+)\*\*/ },
  { kind: "bold", re: /__([^_]+)__/ },
  { kind: "del", re: /~~([^~]+)~~/ },
  { kind: "img", re: /!\[([^\]]*)\]\(([^)\s]+)\)/ },
  { kind: "link", re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { kind: "em", re: /\*([^*\s][^*]*)\*/ },
  { kind: "em", re: /_([^_\s][^_]*)_/ },
];

/** Append `text` to `parent` with inline markdown resolved (recursive for
 *  nested emphasis). Message content only ever enters as text nodes. */
function appendInline(owner: string, parent: HTMLElement, text: string): void {
  let rest = text;
  while (rest.length > 0) {
    let best: { kind: InlineKind; m: RegExpExecArray } | null = null;
    for (const p of INLINE_PATTERNS) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) best = { kind: p.kind, m };
    }
    if (!best) {
      parent.append(document.createTextNode(rest));
      return;
    }
    const { kind, m } = best;
    if (m.index > 0) parent.append(document.createTextNode(rest.slice(0, m.index)));

    const inner = m[1] ?? "";
    if (kind === "code") {
      parent.append(ownedEl("code", { owner, className: "cc-ff-code", text: inner }));
    } else if (kind === "bold" || kind === "em" || kind === "del") {
      const tag = kind === "bold" ? "strong" : kind === "em" ? "em" : "del";
      const el = ownedEl(tag, { owner });
      appendInline(owner, el, inner);
      parent.append(el);
    } else if (kind === "img") {
      // Images can't load in the panel (and shouldn't) — render the alt text.
      parent.append(document.createTextNode(inner || "(image)"));
    } else {
      const url = m[2] ?? "";
      if (/^https?:\/\//i.test(url)) {
        const a = ownedEl("a", {
          owner,
          attrs: { href: url, target: "_blank", rel: "noopener noreferrer" },
        });
        appendInline(owner, a, inner);
        parent.append(a);
      } else {
        parent.append(document.createTextNode(inner));
      }
    }
    rest = rest.slice(m.index + m[0].length);
  }
}
