/**
 * Find in conversation. Conversation scope.
 *
 * A real Ctrl+F built for conversations: a compact companion find bar
 * (fixed top-center, under claude's header) that searches the API-indexed
 * conversation from ctx.conversation — EVERY message, immune to
 * virtualization. The browser's native Ctrl+F only sees the 2–4 rendered
 * messages the virtualizer keeps in the DOM; we search all of them, then
 * jump the virtualizer to the hit via ctx.matcher's proportional-scroll seek.
 *
 * UI: text input (debounced), live "3 / 47" count, prev/next arrows,
 * case-sensitive + whole-word toggles, ✕ close, and a result list where each
 * hit shows a You/Claude tag, a surrounding-context snippet with the match
 * emphasized, and the message ordinal. Clicking a hit (or prev/next) jumps
 * to its message and best-effort emphasizes the matched text in the rendered
 * message once the virtualizer materializes it.
 *
 * DOM SAFETY (the highlights reversible-wrap technique):
 * matched text is wrapped per TEXT NODE with `span.cc-find-hit`, segments
 * wrapped in REVERSE order so earlier offsets stay valid while
 * surroundContents splits the node. textContent stays byte-identical, so
 * dom-matcher probes, folding's fold-head, and highlights' index map are
 * untouched. Spans are deliberately NOT stamped data-cc-owner (the runtime
 * owner-sweep would delete the answer text with them — same rule as
 * mark.cc-hl); they are unwrapped explicitly on every new jump,
 * on query change, on close, and in onCleanup. When a match cannot be
 * re-found in the rendered markup (markdown markers, split text nodes), the
 * message gets a transient outline flash instead — never a corrupted wrap.
 *
 * ENTRY POINTS (features never import each other): bus "ui:find-toggle"
 * from the gear menu's Reading row and the command palette, plus
 * Ctrl/Cmd+Shift+F (free on claude.ai; the browser's native Ctrl+F is left
 * untouched). Enter = next, Shift+Enter = prev, Esc = close.
 *
 * Standards: own-UI-only under #cc-root; managed ctx resources; colors from
 * companion.css var(--cc-*) exclusively; z via .cc-find (Z.panel band).
 * Search is read-only over the index; nothing leaves the browser.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import type { IndexedMessage } from "@/core/conversation-store";
import { ownedEl } from "@/ui/root";
import { chordOf, chordSpoken, chordText } from "@/shared/keymap";

const OWNER = "find-in-conversation";

const DEBOUNCE_MS = 180;
const MAX_HITS = 400;
const SNIPPET_RADIUS = 40;
/** Post-jump emphasis retry (mirrors dom-matcher's seek cadence). */
const EMPHASIS_RETRY_MS = 300;
const EMPHASIS_MAX_TRIES = 16;
const FLASH_MS = 1700;

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface FindHit {
  uuid: string;
  sender: "human" | "assistant";
  /** 1-based message ordinal, for the row hint. */
  msgNo: number;
  /** Snippet parts — match emphasized by the renderer, not by markup. */
  before: string;
  match: string;
  after: string;
}

/** Escape a literal query for RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Literal-query matcher honoring the case toggle (offset-exact — no
 *  toLowerCase length drift on locale edge cases). */
function queryRegExp(query: string, opts: FindOptions): RegExp {
  return new RegExp(escapeRegExp(query), opts.caseSensitive ? "g" : "gi");
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
}

/** Whole-word test on the ORIGINAL text around a match window. */
function isWholeWord(text: string, start: number, end: number): boolean {
  return !isWordChar(text[start - 1]) && !isWordChar(text[end]);
}

/** Collapse runs of whitespace WITHOUT trimming — snippet edges keep their
 *  single boundary space next to the emphasized match. */
function squash(s: string): string {
  return s.replace(/\s+/g, " ");
}

/**
 * Search the full API-indexed message list for a literal query. Pure and
 * headless-testable. Hits are capped at {@link MAX_HITS} (the UI labels the
 * cap); zero-length queries return no hits.
 */
export function findMatches(
  messages: readonly IndexedMessage[],
  query: string,
  opts: FindOptions,
): FindHit[] {
  if (!query) return [];
  const re = queryRegExp(query, opts);
  const hits: FindHit[] = [];
  for (const m of messages) {
    for (const hit of m.text.matchAll(re)) {
      const matched = hit[0];
      const start = hit.index ?? 0;
      const end = start + matched.length;
      if (opts.wholeWord && !isWholeWord(m.text, start, end)) continue;
      const from = Math.max(0, start - SNIPPET_RADIUS);
      hits.push({
        uuid: m.uuid,
        sender: m.sender,
        msgNo: m.index + 1,
        before: (from > 0 ? "…" : "") + squash(m.text.slice(from, start)),
        match: matched,
        after: squash(m.text.slice(end, end + SNIPPET_RADIUS)) + (end + SNIPPET_RADIUS < m.text.length ? "…" : ""),
      });
      if (hits.length >= MAX_HITS) return hits;
    }
  }
  return hits;
}

export const findInConversation: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    // ---- bar chrome (fixed top-center; .cc-find carries Z.panel) -----------
    const bar = ownedEl("div", {
      owner: OWNER,
      className: "cc-find cc-hidden",
      attrs: { id: "cc-find", role: "search", "aria-label": "Find in conversation" },
    });
    const row = ownedEl("div", { owner: OWNER, className: "cc-find-bar" });
    const input = ownedEl("input", {
      owner: OWNER,
      className: "cc-input cc-find-input",
      attrs: {
        type: "text",
        placeholder: "Find in conversation…",
        "aria-label": "Find in conversation",
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    const count = ownedEl("span", {
      owner: OWNER,
      className: "cc-find-count",
      attrs: { "aria-live": "polite" },
    });
    // `title` carries the platform's printed chord; `aria-label` carries the
    // spoken form — "⇧Enter" read literally is noise (@/shared/keymap).
    const navBtn = (text: string, title: string, label = title): HTMLButtonElement =>
      ownedEl("button", {
        owner: OWNER,
        className: "cc-btn cc-find-btn",
        text,
        attrs: { type: "button", title, "aria-label": label },
      });
    const prevChord = chordOf("findPrev");
    const nextChord = chordOf("findNext");
    const prevBtn = navBtn(
      "↑",
      `Previous match (${chordText(prevChord)})`,
      `Previous match, ${chordSpoken(prevChord)}`,
    );
    const nextBtn = navBtn(
      "↓",
      `Next match (${chordText(nextChord)})`,
      `Next match, ${chordSpoken(nextChord)}`,
    );
    const caseBtn = navBtn("Aa", "Match case");
    caseBtn.setAttribute("aria-pressed", "false");
    const wordBtn = navBtn("|ab|", "Whole word");
    wordBtn.setAttribute("aria-pressed", "false");
    const closeBtn = ownedEl("button", {
      owner: OWNER,
      className: "cc-find-close",
      text: "✕",
      attrs: { type: "button", title: "Close (Esc)", "aria-label": "Close find bar" },
    });
    row.append(input, count, prevBtn, nextBtn, caseBtn, wordBtn, closeBtn);
    const list = ownedEl("div", { owner: OWNER, className: "cc-find-list" });
    bar.append(row, list);
    ctx.root.append(bar);

    // ---- state ---------------------------------------------------------------
    let open = false;
    const opts: FindOptions = { caseSensitive: false, wholeWord: false };
    let hits: FindHit[] = [];
    /** Active hit; -1 = fresh search, nothing navigated to yet. */
    let current = -1;
    let searchToken = 0; // debounce + stale-result guard
    let emphasisToken = 0; // cancels a pending post-jump emphasis retry loop

    // ---- in-message emphasis (reversible wrap; unstamped spans) --------------
    const unwrapAll = (): void => {
      emphasisToken++;
      for (const s of document.querySelectorAll<HTMLElement>("span.cc-find-hit")) {
        const parent = s.parentNode;
        s.replaceWith(...s.childNodes);
        parent?.normalize(); // merge the splits back — leave no trace
      }
      for (const el of document.querySelectorAll<HTMLElement>(".cc-find-flash")) {
        el.classList.remove("cc-find-flash");
      }
    };

    const walkerFilter: NodeFilter = {
      acceptNode: (n: Node) =>
        n.parentElement?.closest(
          "[data-cc-owner], span.cc-find-hit, .cc-gutter, .cc-foldhead, .cc-meta-area",
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    };

    /** Wrap every query occurrence in `el`'s text nodes. Returns the count.
     *  REVERSE order keeps earlier offsets valid while surroundContents
     *  splits the node (the original Text keeps the leading run). */
    const wrapIn = (el: HTMLElement, query: string): number => {
      const re = queryRegExp(query, opts);
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, walkerFilter);
      const nodes: Text[] = [];
      while (tw.nextNode()) nodes.push(tw.currentNode as Text);
      let wrapped = 0;
      for (const node of nodes) {
        const text = node.textContent ?? "";
        if (text.length < query.length) continue;
        const ranges: Array<{ start: number; end: number }> = [];
        for (const hit of text.matchAll(re)) {
          const start = hit.index ?? 0;
          const end = start + hit[0].length;
          if (opts.wholeWord && !isWholeWord(text, start, end)) continue;
          ranges.push({ start, end });
        }
        for (const r of ranges.reverse()) {
          const range = document.createRange();
          range.setStart(node, r.start);
          range.setEnd(node, r.end);
          const span = document.createElement("span");
          // Deliberately unstamped — see the header comment.
          span.className = "cc-find-hit";
          try {
            range.surroundContents(span);
            wrapped++;
          } catch {
            /* partial-element edge — skip this occurrence, keep the rest */
          }
        }
      }
      return wrapped;
    };

    /** Best-effort emphasis after a jump: wait for the virtualizer to render
     *  the message (dom-matcher is mid-seek), then wrap. If the rendered
     *  markup splits the match (markdown), flash the message outline. */
    const emphasize = (uuid: string, query: string): void => {
      const token = ++emphasisToken;
      let tries = 0;
      const attempt = (): void => {
        if (token !== emphasisToken || ctx.signal.aborted) return;
        const el = ctx.matcher.elementForUuid(uuid);
        if (el) {
          if (wrapIn(el, query) === 0) {
            el.classList.add("cc-find-flash");
            ctx.setTimeout(() => {
              if (!ctx.signal.aborted) el.classList.remove("cc-find-flash");
            }, FLASH_MS);
          }
          return;
        }
        tries++;
        if (tries < EMPHASIS_MAX_TRIES) ctx.setTimeout(attempt, EMPHASIS_RETRY_MS);
      };
      attempt();
    };

    // ---- rendering -----------------------------------------------------------
    const renderCount = (): void => {
      if (!input.value) {
        count.textContent = "";
      } else if (hits.length === 0) {
        count.textContent = "0 / 0";
      } else {
        const total = hits.length >= MAX_HITS ? `${MAX_HITS}+` : String(hits.length);
        count.textContent = current >= 0 ? `${current + 1} / ${total}` : `${total}`;
      }
      const none = hits.length === 0;
      prevBtn.disabled = none;
      nextBtn.disabled = none;
    };

    const paintActive = (): void => {
      for (const rowEl of list.querySelectorAll<HTMLElement>(".cc-find-row")) {
        if (Number(rowEl.getAttribute("data-cc-i")) === current) {
          rowEl.setAttribute("data-active", "1");
          rowEl.scrollIntoView({ block: "nearest" });
        } else {
          rowEl.removeAttribute("data-active");
        }
      }
    };

    const renderList = (): void => {
      list.replaceChildren();
      if (!input.value) return; // list collapses via :empty
      if (hits.length === 0) {
        const index = ctx.conversation.current();
        list.append(
          ownedEl("div", {
            owner: OWNER,
            className: "cc-find-empty",
            text: index ? "No matches in this conversation." : "Still indexing this conversation…",
          }),
        );
        return;
      }
      hits.forEach((h, i) => {
        const rowEl = ownedEl("div", {
          owner: OWNER,
          className: "cc-find-row",
          attrs: { role: "button", tabindex: "-1", "data-cc-i": String(i) },
        });
        const snip = ownedEl("span", { owner: OWNER, className: "cc-find-snip" });
        snip.append(
          document.createTextNode(h.before),
          ownedEl("span", { owner: OWNER, className: "cc-find-em", text: h.match }),
          document.createTextNode(h.after),
        );
        rowEl.append(
          ownedEl("span", {
            owner: OWNER,
            className: "cc-find-who",
            text: h.sender === "human" ? "You" : "Claude",
          }),
          snip,
          ownedEl("span", { owner: OWNER, className: "cc-find-no", text: `#${h.msgNo}` }),
        );
        list.append(rowEl);
      });
      if (hits.length >= MAX_HITS) {
        list.append(
          ownedEl("div", {
            owner: OWNER,
            className: "cc-find-empty",
            text: `Showing the first ${MAX_HITS} matches — refine the search.`,
          }),
        );
      }
      paintActive();
    };

    // ---- search ---------------------------------------------------------------
    const runSearch = (): void => {
      const index = ctx.conversation.current();
      hits = index ? findMatches(index.messages, input.value, opts) : [];
      current = -1; // fresh result set — Enter goes to the first hit
      unwrapAll(); // stale emphasis no longer matches the query
      renderCount();
      renderList();
    };

    const scheduleSearch = (): void => {
      const token = ++searchToken;
      ctx.setTimeout(() => {
        if (token === searchToken && open) runSearch();
      }, DEBOUNCE_MS);
    };

    // ---- navigation ------------------------------------------------------------
    const goTo = (i: number): void => {
      const hit = hits[i];
      if (!hit) return;
      current = i;
      renderCount();
      paintActive();
      unwrapAll();
      ctx.matcher.jumpTo(hit.uuid); // the one seek — proportional scroll + retry
      emphasize(hit.uuid, input.value);
    };
    const next = (): void => {
      if (hits.length > 0) goTo((current + 1) % hits.length);
    };
    const prev = (): void => {
      if (hits.length > 0) goTo((current - 1 + hits.length) % hits.length);
    };

    // ---- open / close -----------------------------------------------------------
    const close = (): void => {
      if (!open) return;
      open = false;
      bar.classList.add("cc-hidden");
      unwrapAll();
    };
    const openBar = (): void => {
      open = true;
      bar.classList.remove("cc-hidden");
      // Make sure the API index exists (quiet no-op when already cached).
      void ctx.conversation.ensure().then(() => {
        if (!ctx.signal.aborted && open && input.value) runSearch();
      });
      runSearch();
      input.focus();
      input.select();
    };
    const toggle = (): void => {
      if (open) close();
      else openBar();
    };

    // ---- entry points (gear menu + palette via the bus; own shortcut) ----------
    ctx.on("ui:find-toggle", () => toggle());
    // Ctrl/Cmd+Shift+F — free on claude.ai; the browser's native Ctrl+F stays
    // untouched. Captured ahead of the page's own handlers (palette idiom).
    ctx.listen(
      window,
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.code === "KeyF" && ev.shiftKey && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
          ev.preventDefault();
          ev.stopPropagation();
          toggle();
        }
      },
      { capture: true },
    );

    // ---- interaction ------------------------------------------------------------
    ctx.listen(input, "input", scheduleSearch);
    ctx.listen(input, "keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (ev.shiftKey) prev();
        else next();
      } else if (ev.key === "ArrowDown") {
        ev.preventDefault();
        next();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        prev();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    });
    // Keep find-bar keystrokes out of claude's global shortcut handlers.
    ctx.listen(bar, "keydown", (ev: KeyboardEvent) => ev.stopPropagation());

    ctx.listen(prevBtn, "click", () => prev());
    ctx.listen(nextBtn, "click", () => next());
    const toggleOpt = (key: keyof FindOptions, btn: HTMLButtonElement): void => {
      opts[key] = !opts[key];
      btn.setAttribute("aria-pressed", opts[key] ? "true" : "false");
      runSearch();
      input.focus();
    };
    ctx.listen(caseBtn, "click", () => toggleOpt("caseSensitive", caseBtn));
    ctx.listen(wordBtn, "click", () => toggleOpt("wholeWord", wordBtn));
    ctx.listen(closeBtn, "click", () => close());

    ctx.listen(list, "click", (ev: MouseEvent) => {
      const rowEl =
        ev.target instanceof Element ? ev.target.closest<HTMLElement>(".cc-find-row") : null;
      if (!rowEl) return;
      const i = Number(rowEl.getAttribute("data-cc-i"));
      if (Number.isInteger(i)) goTo(i);
    });

    // Esc from anywhere on the page closes the bar (panel idiom).
    ctx.listen(
      document,
      "keydown",
      (ev: KeyboardEvent) => {
        if (!open || ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        close();
      },
      { capture: true },
    );

    // ---- live re-search while open (post-generation refetch, fresh index) ------
    ctx.on("conversation:indexed", () => {
      if (open && input.value) runSearch();
    });
    ctx.on("conversation:updated", () => {
      if (open && input.value) runSearch();
    });

    // ---- teardown: bar nodes are owner-swept; the unstamped wraps are ours ----
    ctx.onCleanup(() => unwrapAll());
  },
};
