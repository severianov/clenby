/**
 * Highlights — Tier 2, conversation scope.
 * Whitespace-insensitive wrapping + robust selection detection, animated
 * pen-sweep create/retract + no-animation re-apply loop, hover-✕ delete.
 *
 * Behavior carried over (all fixed bugs):
 * - Select text in a thread answer → floating 🖍 Highlight / ✕ Unhighlight
 *   chip. The answer AND any existing mark are detected via
 *   range.intersectsNode — anchor parentElement checks FAIL on element-level
 *   selections (e.g. triple-click / select-all inside a message).
 * - Companion UI text is stripped from the selection before matching: the
 *   cloned range fragment drops every [data-cc-owner] node (gutter buttons,
 *   fold heads, meta lines) so their glyphs never poison the needle.
 * - Wrapping is whitespace-insensitive: the needle and the message's text-node
 *   stream are both collapsed with an index map, then the matching raw span is
 *   wrapped per text-node segment IN REVERSE ORDER (keeps offsets valid) with
 *   `mark.cc-hl` (gold, var(--cc-gold) via companion.css).
 * - Pen-sweep animation on create (staggered background-size wipe) and a
 *   retract sweep on remove — CSS keyframes, disabled under
 *   prefers-reduced-motion (companion.css).
 * - Re-apply loop (ctx.setInterval, 1.5 s) restores marks the virtualizer
 *   discarded, WITHOUT animation (no surprise sweeps while scrolling); host
 *   elements are found via ctx.matcher.uuidForElement.
 * - Hover-✕ on a mark removes that highlight.
 * - Persistence: ctx.storage.conv key "highlights" — HighlightRecord[]
 *   ({id, uuid|null, text, at}) — migrated from the legacy
 *   `cc-hls-<convId>`. Creation WRAPS FIRST and stores uuid:null on a probe
 *   miss (resolved later by the re-apply loop).
 * - Outline's Marks tab reads the same storage key; changes are broadcast as
 *   "conversation:updated" so the panel rebuilds (features never import each
 *   other). Jump + .cc-flash live in outline.
 * - Marks are NOT stamped data-cc-owner (the runtime owner-sweep would delete
 *   the highlighted text with them); they are unwrapped in ctx.onCleanup.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import type { HighlightRecord } from "@/core/storage";
import { ownedEl, setGeometry } from "@/ui/root";
import { prefersReducedMotion } from "@/ui/motion";

const SELECT_DEBOUNCE_MS = 180;
const REAPPLY_MS = 1500;
const HX_HIDE_DELAY_MS = 250;
const MIN_LEN = 3;
const MAX_LEN = 4000;
const STORED_TEXT_MAX = 2000;

type Pending =
  | { kind: "add"; el: HTMLElement; text: string }
  | { kind: "remove"; id: string };

export const highlights: FeatureModule = {
  id: "highlights",
  tier: 2,
  scope: "conversation",

  async mount(ctx: FeatureContext) {
    let records: HighlightRecord[] = await ctx.storage.conv.get("highlights");
    void ctx.conversation.ensure();

    // ---- UI: selection chip + hover-✕, both under #cc-root ----------------
    const chip = ownedEl("button", {
      owner: "highlights",
      className: "cc-chip cc-hlchip",
      attrs: { type: "button" },
    });
    const hx = ownedEl("button", {
      owner: "highlights",
      className: "cc-hlx",
      text: "✕",
      attrs: { type: "button", title: "Remove highlight" },
    });
    ctx.root.append(chip, hx);

    let pending: Pending | null = null;

    const answers = (): HTMLElement[] =>
      ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);

    const marksFor = (id: string): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>(`mark.cc-hl[data-hl-id="${CSS.escape(id)}"]`),
    ];

    const persist = (): void => {
      void ctx.storage.conv.set("highlights", records);
      const convId = ctx.storage.convId;
      if (convId) ctx.bus.emit("conversation:updated", { convId });
    };

    // ---- wrapping (ccWrapHl port, whitespace-insensitive) ------------------
    const walkerFilter: NodeFilter = {
      acceptNode: (n: Node) =>
        n.parentElement?.closest("[data-cc-owner], mark.cc-hl, .cc-gutter, .cc-foldhead, .cc-meta-area")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    };

    const wrapHl = (el: HTMLElement, text: string, id: string, animate: boolean): boolean => {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, walkerFilter);
      const nodes: Array<{ node: Text; start: number }> = [];
      let full = "";
      while (tw.nextNode()) {
        const node = tw.currentNode as Text;
        nodes.push({ node, start: full.length });
        full += node.textContent ?? "";
      }
      const normNeedle = text.replace(/\s+/g, "");
      if (!normNeedle) return false;

      // Collapse whitespace with a norm→raw index map.
      let norm = "";
      const map: number[] = [];
      for (let i = 0; i < full.length; i++) {
        const ch = full.charAt(i);
        if (!/\s/.test(ch)) {
          norm += ch;
          map.push(i);
        }
      }
      const nIdx = norm.indexOf(normNeedle);
      if (nIdx < 0) return false;
      const rawStart = map[nIdx];
      const rawLast = map[nIdx + normNeedle.length - 1];
      if (rawStart === undefined || rawLast === undefined) return false;
      const rawEnd = rawLast + 1;

      const segs: Array<{ node: Text; s: number; e: number }> = [];
      for (const { node, start } of nodes) {
        const len = (node.textContent ?? "").length;
        const nEnd = start + len;
        if (nEnd <= rawStart || start >= rawEnd) continue;
        segs.push({ node, s: Math.max(0, rawStart - start), e: Math.min(len, rawEnd - start) });
      }
      // REVERSE order keeps earlier offsets valid while we split nodes.
      for (const { node, s, e } of segs.reverse()) {
        if (s >= e) continue;
        const r = document.createRange();
        r.setStart(node, s);
        r.setEnd(node, e);
        const mk = document.createElement("mark");
        mk.className = "cc-hl";
        mk.dataset["hlId"] = id;
        try {
          r.surroundContents(mk);
        } catch {
          /* partial-element edge — skip this segment, keep the rest */
        }
      }

      if (animate && !prefersReducedMotion()) {
        const marks = marksFor(id);
        marks.forEach((m, i) => {
          m.style.animationDelay = `${i * 0.1}s`; // timing-only inline (stagger)
          m.classList.add("cc-hl-in");
        });
        ctx.setTimeout(
          () => {
            for (const m of marks) {
              m.classList.remove("cc-hl-in");
              m.style.animationDelay = "";
            }
          },
          450 + marks.length * 100,
        );
      }
      return true;
    };

    // ---- removal (ccUnhl port: retract sweep, then unwrap) -----------------
    const unwrap = (m: HTMLElement): void => {
      if (!m.isConnected) return;
      const parent = m.parentNode;
      m.replaceWith(...m.childNodes);
      parent?.normalize();
    };

    const unhighlight = (id: string): void => {
      // Delete the record FIRST — removal must be deterministic. If the
      // record survived until after the retract animation, the 1.5 s re-apply
      // loop (or a virtualization re-render) could re-wrap the text in the
      // meantime and the "removed" highlight would come back.
      records = records.filter((h) => h.id !== id);
      persist();
      const finish = (): void => {
        // Re-query at unwrap time: marks captured before the animation can go
        // stale (virtualizer re-render), and a highlight may span MULTIPLE
        // segments — every remaining segment with this id is unwrapped.
        for (const m of marksFor(id)) unwrap(m);
      };
      const marks = marksFor(id);
      if (prefersReducedMotion() || marks.length === 0) {
        finish();
        return;
      }
      marks.forEach((m, i) => {
        m.style.animationDelay = `${(marks.length - 1 - i) * 0.08}s`;
        m.classList.add("cc-hl-out");
      });
      ctx.setTimeout(finish, 320 + marks.length * 80);
    };

    // The outline's Marks-tab ✕ removes the record + unwraps what it can see,
    // then broadcasts. Drop the id from OUR in-memory records too (otherwise
    // the re-apply loop would restore the mark from stale memory) and unwrap
    // any segment the outline missed.
    ctx.on("highlights:removed", ({ id }) => {
      records = records.filter((h) => h.id !== id);
      for (const m of marksFor(id)) unwrap(m);
    });

    // ---- selection chip -----------------------------------------------------
    const updateChip = (): void => {
      chip.classList.remove("cc-on");
      pending = null;
      const sel = document.getSelection();
      const raw = sel?.toString().trim() ?? "";
      if (!sel || sel.rangeCount === 0 || raw.length < MIN_LEN || raw.length > MAX_LEN) return;
      const range = sel.getRangeAt(0);

      // range.intersectsNode, not anchor parentElement — element-level
      // selections have element anchors and would slip through otherwise.
      const msgEl = answers().find((el) => {
        try {
          return range.intersectsNode(el);
        } catch {
          return false;
        }
      });
      if (!msgEl) return;

      // Clean needle: drop companion UI nodes from the cloned fragment.
      let text = raw;
      try {
        const frag = range.cloneContents();
        for (const n of frag.querySelectorAll("[data-cc-owner], .cc-gutter, .cc-foldhead, .cc-meta-area")) {
          n.remove();
        }
        const ct = (frag.textContent ?? "").trim();
        if (ct.length >= MIN_LEN) text = ct;
      } catch {
        /* selection APIs can throw on odd ranges — fall back to raw */
      }

      const mk = [...document.querySelectorAll<HTMLElement>("mark.cc-hl")].find((m) => {
        try {
          return range.intersectsNode(m);
        } catch {
          return false;
        }
      });

      const r = range.getBoundingClientRect();
      setGeometry(chip, {
        left: Math.min(window.innerWidth - 140, Math.max(8, r.left)),
        top: Math.max(8, r.top - 36),
      });
      if (mk) {
        chip.textContent = "✕ Unhighlight";
        pending = { kind: "remove", id: mk.dataset["hlId"] ?? "" };
      } else {
        chip.textContent = "🖍 Highlight";
        pending = { kind: "add", el: msgEl, text };
      }
      chip.classList.add("cc-on");
    };

    // Token debounce (ctx.setTimeout has no clear handle — stale runs no-op).
    let selToken = 0;
    ctx.listen(document, "selectionchange", () => {
      const t = ++selToken;
      ctx.setTimeout(() => {
        if (t === selToken) updateChip();
      }, SELECT_DEBOUNCE_MS);
    });

    ctx.listen(chip, "click", (ev: Event) => {
      ev.stopPropagation();
      if (!pending) return;
      if (pending.kind === "remove") {
        if (pending.id) unhighlight(pending.id);
      } else {
        // WRAP FIRST: highlighting must always give visible
        // feedback. On a probe miss (fresh load, tool-block/artifact openers)
        // the uuid is stored as null and back-filled by the re-apply loop —
        // only re-apply-after-virtualization degrades, never creation.
        const id = Date.now().toString(36);
        if (wrapHl(pending.el, pending.text, id, true)) {
          const uuid = ctx.matcher.uuidForElement(pending.el);
          records.push({
            id,
            uuid,
            text: pending.text.slice(0, STORED_TEXT_MAX),
            at: new Date().toISOString(),
          });
          persist();
        }
      }
      pending = null;
      chip.classList.remove("cc-on");
      document.getSelection()?.removeAllRanges();
    });

    // ---- hover-✕ on marks ---------------------------------------------------
    let hxId: string | null = null;
    let hxToken = 0;
    ctx.listen(document, "mouseover", (ev: MouseEvent) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target) return;
      const mk = target.closest<HTMLElement>("mark.cc-hl");
      if (mk) {
        hxToken++;
        hxId = mk.dataset["hlId"] ?? null;
        const r = mk.getBoundingClientRect();
        setGeometry(hx, {
          left: Math.min(window.innerWidth - 24, r.right - 6),
          top: Math.max(4, r.top - 14),
        });
        hx.classList.add("cc-on");
      } else if (target === hx || hx.contains(target)) {
        hxToken++; // hovering the ✕ itself — keep it up
      } else {
        const t = ++hxToken;
        ctx.setTimeout(() => {
          if (t === hxToken) hx.classList.remove("cc-on");
        }, HX_HIDE_DELAY_MS);
      }
    });
    ctx.listen(hx, "click", (ev: Event) => {
      ev.stopPropagation();
      if (hxId) unhighlight(hxId);
      hx.classList.remove("cc-on");
    });

    // ---- re-apply against virtualization re-renders (no animation) ---------
    const reapply = (): void => {
      // Orphan sweep first: unwrap any mark whose record is gone (belt +
      // braces against every desync path — a mark without a record can
      // otherwise linger in the text forever).
      const live = new Set(records.map((h) => h.id));
      for (const m of document.querySelectorAll<HTMLElement>("mark.cc-hl")) {
        const id = m.dataset["hlId"];
        if (!id || !live.has(id)) unwrap(m);
      }
      for (const h of records) {
        // Late uuid resolution for wrap-first records: if
        // the mark is still rendered, ask the matcher again via its host.
        if (h.uuid === null) {
          const mk = marksFor(h.id)[0];
          const host = mk ? ctx.selectors.closest<HTMLElement>("assistantMessage", mk) : null;
          const uuid = host ? ctx.matcher.uuidForElement(host) : null;
          if (uuid) {
            h.uuid = uuid;
            persist();
          }
        }
        if (marksFor(h.id).length > 0) continue;
        // Unresolved records can't be located after a re-render — skip (a
        // null-uuid compare would false-match any still-unindexed answer).
        if (h.uuid === null) continue;
        const el = answers().find((e) => ctx.matcher.uuidForElement(e) === h.uuid);
        if (el) wrapHl(el, h.text, h.id, false);
      }
    };
    ctx.setInterval(reapply, REAPPLY_MS);
    reapply();

    // ---- teardown: unwrap every mark (they are unstamped by design) --------
    ctx.onCleanup(() => {
      for (const m of document.querySelectorAll<HTMLElement>("mark.cc-hl")) unwrap(m);
    });
  },
};
