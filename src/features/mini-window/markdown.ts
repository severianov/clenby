/**
 * Mini-window markdown renderer — API message text → companion-owned DOM.
 *
 * Purpose-built for the floating card body (NOT a general parser): headings,
 * paragraphs, `inline code`, fenced code blocks, ordered "steps" lists,
 * bullet lists, blockquotes, hr, links, bold/italic/strikethrough, and
 * TICKABLE checklists (`- [ ]` / `- [x]` → .cc-mw-check rows; the card's
 * delegated click handler toggles .cc-done — checked state lives in the DOM
 * for the card's lifetime, the agreed v1 memory).
 *
 * Safety: every piece of MESSAGE content enters the DOM via textContent /
 * createTextNode — never innerHTML. The only innerHTML here is the bundled
 * static tick icon (same policy as export's icon constants). Links render
 * only for http(s) URLs; anything else falls back to plain text.
 *
 * All styling comes from companion.css classes reading var(--cc-*) — this
 * module writes zero inline styles.
 */

import { ownedEl } from "@/ui/root";

/** Static, trusted markup — the checklist tick (stroke: currentColor). */
const ICON_TICK =
  '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 5.5l2.4 2.4L8.5 2.5"/></svg>';

const CHECK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const HEADING_RE = /^(#{1,4})\s+(.*)$/;
const FENCE_OPEN_RE = /^\s*```/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

/** Render markdown into a fresh `.cc-mw-md` container. */
export function renderMarkdown(owner: string, md: string): HTMLDivElement {
  const root = ownedEl("div", { owner, className: "cc-mw-md" });
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
      const codeEl = ownedEl("code", { owner, text: code.join("\n") });
      pre.append(codeEl);
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
      const tag = `h${lvl}` as "h1" | "h2" | "h3" | "h4";
      const el = ownedEl(tag, { owner });
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

    const q = QUOTE_RE.exec(line);
    if (q) {
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

    // Checklist runs BEFORE plain lists — `- [ ]` also matches UL_RE.
    if (CHECK_RE.test(line)) {
      flushPara();
      const wrap = ownedEl("div", { owner, className: "cc-mw-checks" });
      while (i < lines.length) {
        const m = CHECK_RE.exec(lines[i] ?? "");
        if (!m) break;
        wrap.append(buildCheckRow(owner, (m[1] ?? " ") !== " ", m[2] ?? ""));
        i++;
      }
      root.append(wrap);
      continue;
    }

    if (OL_RE.test(line)) {
      flushPara();
      const ol = ownedEl("ol", { owner, className: "cc-mw-steps" });
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (CHECK_RE.test(l)) break;
        const m = OL_RE.exec(l);
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
        const l = lines[i] ?? "";
        if (CHECK_RE.test(l)) break;
        const m = UL_RE.exec(l);
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

function buildCheckRow(owner: string, done: boolean, label: string): HTMLElement {
  const row = ownedEl("div", {
    owner,
    className: "cc-mw-check" + (done ? " cc-done" : ""),
    attrs: { role: "checkbox", "aria-checked": done ? "true" : "false", tabindex: "0" },
  });
  const box = ownedEl("span", { owner, className: "cc-mw-box" });
  box.innerHTML = ICON_TICK; // static, trusted markup (bundled icon constant)
  const lbl = ownedEl("span", { owner, className: "cc-mw-lbl" });
  appendInline(owner, lbl, label);
  row.append(box, lbl);
  return row;
}

// ---------------------------------------------------------------------------
// Inline markdown → nodes
// ---------------------------------------------------------------------------

type InlineKind = "code" | "bold" | "em" | "del" | "img" | "link";

interface InlinePattern {
  kind: InlineKind;
  re: RegExp;
}

/** Order = tie-break priority at equal match index (code always wins; `**`
 *  before `*` so bold is never half-eaten by italic). */
const INLINE_PATTERNS: readonly InlinePattern[] = [
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
 *  nested emphasis inside bold/links). Message content only ever enters as
 *  text nodes. */
export function appendInline(owner: string, parent: HTMLElement, text: string): void {
  let rest = text;
  while (rest.length > 0) {
    let best: { kind: InlineKind; m: RegExpExecArray } | null = null;
    for (const p of INLINE_PATTERNS) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.m.index)) {
        best = { kind: p.kind, m };
      }
    }
    if (!best) {
      parent.append(document.createTextNode(rest));
      return;
    }
    const { kind, m } = best;
    if (m.index > 0) parent.append(document.createTextNode(rest.slice(0, m.index)));

    const inner = m[1] ?? "";
    if (kind === "code") {
      parent.append(ownedEl("code", { owner, className: "cc-mw-code", text: inner }));
    } else if (kind === "bold") {
      const el = ownedEl("strong", { owner });
      appendInline(owner, el, inner);
      parent.append(el);
    } else if (kind === "em") {
      const el = ownedEl("em", { owner });
      appendInline(owner, el, inner);
      parent.append(el);
    } else if (kind === "del") {
      const el = ownedEl("del", { owner });
      appendInline(owner, el, inner);
      parent.append(el);
    } else if (kind === "img") {
      // Images can't load in the card (and shouldn't) — render the alt text.
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
