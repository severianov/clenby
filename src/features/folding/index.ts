/**
 * Folding v3 — Tier 2 rider, conversation scope.
 * Structural message folding with font-matched heads, built on the managed
 * feature lifecycle + decorations gutter.
 *
 * Behavior notes (fixed landmines):
 * - STRUCTURAL collapse: `.cc-collapsed > *:not(.cc-foldhead):not(.cc-gutter)
 *   {display:none}` (companion.css) — NOT maxHeight clipping, which broke
 *   across themes. The gutter stays visible so the + button can reopen.
 * - Generated fold-head = the message's first meaningful line, fully visible,
 *   + a ⋯ badge. Clicking the line, the ⋯, or the + button reopens.
 * - Fold-head font MATCHES the message font (theme-independent — the fixed
 *   font-size bug): computed font-size/family/COLOR from a real p/li/heading
 *   are bridged to CSS via --cc-fold-* custom properties, never hardcoded.
 * - FLIP height animation (~0.28 s) on fold AND unfold — the structural class
 *   is applied only when the slide finishes, so content stays visible while
 *   shrinking. Skipped under prefers-reduced-motion.
 * - Fold-all / Unfold-all: consumes the bus "fold:all" broadcast (emitted by
 *   the header-cluster gear menu) with a 35 ms cascade; newly rendered
 *   messages inherit the current fold-all state without animation. The state
 *   is GLOBAL across conversation switches,
 *   held in module scope — never persisted.
 * - Thread-only guard: the gutter slot comes from ctx.decorations.gutterSlot,
 *   which returns null outside [data-test-render-count] — answers rendered in
 *   the artifact/document viewer never get fold controls.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl } from "@/ui/root";
import { CASCADE_STEP_MS, animateHeight, prefersReducedMotion } from "@/ui/motion";

const SWEEP_MS = 800;
/** Lines the fold-head must skip: companion glyph rows and meta-line stamps. */
const GLYPH_LINE = /^[+\-−⋯📌✕]+$/;
const META_LINE = /^\w{3} \d{2} · /;

/** Fold-all state newly rendered messages inherit. GLOBAL for the content-
 *  script session — it deliberately survives SPA chat
 *  switches, so this is a module-level UI toggle, not
 *  per-conversation state (and deliberately not persisted to storage). */
let globalFoldAll = false;

export const folding: FeatureModule = {
  id: "folding",
  tier: 2,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    const answers = (): HTMLElement[] =>
      ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);

    const firstLine = (el: HTMLElement): string => {
      const line = (el.innerText || "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !GLYPH_LINE.test(l) && !META_LINE.test(l));
      return line ?? "(empty)";
    };

    /** Bridge the message's computed font AND color onto the head
     *  — values are computed, never literal. The color bridge matters
     *  because themes color answers via !important DESCENDANT selectors the
     *  head doesn't match, so plain `inherit` misses the themed color. */
    const styleHead = (head: HTMLElement, el: HTMLElement): void => {
      const ref = el.querySelector<HTMLElement>("p, li, h1, h2, h3") ?? el;
      const cs = getComputedStyle(ref);
      head.style.setProperty("--cc-fold-fs", cs.fontSize);
      head.style.setProperty("--cc-fold-ff", cs.fontFamily);
      head.style.setProperty("--cc-fold-color", cs.color);
    };

    const mkHead = (el: HTMLElement): HTMLElement => {
      const head = ownedEl("div", { owner: "folding", className: "cc-foldhead" });
      const t = ownedEl("span", { owner: "folding", className: "cc-t", text: firstLine(el) });
      const ell = ownedEl("span", { owner: "folding", className: "cc-ell", text: "⋯" });
      head.append(t, ell);
      styleHead(head, el);
      return head;
    };

    const btnOf = (el: HTMLElement): HTMLButtonElement | null =>
      el.querySelector<HTMLButtonElement>(":scope > .cc-gutter .cc-foldbtn");

    const setFold = (el: HTMLElement, fold: boolean, animate = true): void => {
      if (el.dataset["ccAnim"]) return;
      const btn = btnOf(el);
      const reduced = prefersReducedMotion() || !animate;

      if (fold) {
        if (el.classList.contains("cc-collapsed")) return;
        const head = mkHead(el);
        el.insertBefore(head, el.firstChild);
        if (btn) btn.textContent = "+";
        if (reduced) {
          el.classList.add("cc-collapsed");
          return;
        }
        const h0 = el.getBoundingClientRect().height;
        el.classList.add("cc-collapsed");
        const h1 = el.getBoundingClientRect().height;
        el.classList.remove("cc-collapsed");
        // Class lands in onDone → body stays visible while the height shrinks.
        animateHeight(el, h0, h1, () => el.classList.add("cc-collapsed"));
      } else {
        if (!el.classList.contains("cc-collapsed")) return;
        if (btn) btn.textContent = "−";
        const head = el.querySelector<HTMLElement>(":scope > .cc-foldhead");
        if (reduced) {
          el.classList.remove("cc-collapsed");
          head?.remove();
          return;
        }
        const h0 = el.getBoundingClientRect().height;
        el.classList.remove("cc-collapsed");
        head?.remove();
        const h1 = el.getBoundingClientRect().height;
        animateHeight(el, h0, h1);
      }
    };

    const equip = (el: HTMLElement): void => {
      // Thread-only guard lives in decorations — null outside the thread.
      const slot = ctx.decorations.gutterSlot(el, "folding");
      if (!slot) return;
      let btn = slot.querySelector<HTMLButtonElement>(":scope > .cc-foldbtn");
      if (!btn) {
        btn = ownedEl("button", {
          owner: "folding",
          className: "cc-foldbtn",
          text: el.classList.contains("cc-collapsed") ? "+" : "−",
          attrs: { type: "button", title: "Fold / unfold" },
        });
        slot.append(btn);
        // New-rendered messages inherit the fold-all state (no animation —
        // they may appear mid-scroll or mid-stream).
        if (globalFoldAll && !el.classList.contains("cc-collapsed")) setFold(el, true, false);
      }
      // Keep the head's font bridge fresh (theme switches change computed values).
      const head = el.querySelector<HTMLElement>(":scope > .cc-foldhead");
      if (head) styleHead(head, el);
    };

    const sweep = (): void => {
      for (const el of answers()) equip(el);
    };

    // One delegated listener instead of per-button handlers — nothing to
    // rebind when virtualization re-renders, nothing accruing in the ledger.
    ctx.listen(document, "click", (ev: MouseEvent) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target) return;

      const btn = target.closest(".cc-foldbtn");
      if (btn && btn.closest('[data-cc-owner="folding"]')) {
        const el = ctx.selectors.closest<HTMLElement>("assistantMessage", btn);
        if (!el) return;
        ev.stopPropagation();
        setFold(el, !el.classList.contains("cc-collapsed"));
        return;
      }

      const head = target.closest<HTMLElement>(".cc-foldhead");
      if (head) {
        const el = ctx.selectors.closest<HTMLElement>("assistantMessage", head);
        if (!el) return;
        ev.stopPropagation();
        setFold(el, false);
      }
    });

    // Fold-all / Unfold-all broadcast (gear menu emits; we own the mechanics).
    ctx.on("fold:all", ({ folded }) => {
      globalFoldAll = folded;
      const els = answers().sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      );
      const reduced = prefersReducedMotion();
      els.forEach((el, i) => {
        equip(el);
        if (reduced || i === 0) setFold(el, folded, !reduced);
        else ctx.setTimeout(() => setFold(el, folded), i * CASCADE_STEP_MS);
      });
    });

    ctx.setInterval(sweep, SWEEP_MS);
    sweep();

    // Restore claude's DOM on unmount: drop the structural class + any
    // mid-animation residue. Heads/buttons carry data-cc-owner="folding" and
    // are swept by the runtime.
    ctx.onCleanup(() => {
      for (const el of document.querySelectorAll<HTMLElement>(".cc-collapsed")) {
        el.classList.remove("cc-collapsed");
      }
      for (const el of document.querySelectorAll<HTMLElement>("[data-cc-anim]")) {
        el.style.transition = "";
        el.style.height = "";
        el.style.overflow = "";
        delete el.dataset["ccAnim"];
      }
    });
  },
};
