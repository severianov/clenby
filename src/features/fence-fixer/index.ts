/**
 * Fence fixer — Output repair. Conversation scope.
 *
 * When an unclosed markdown code fence in an assistant message makes the rest
 * of it render as one giant code block, offer a DISPLAY-ONLY repair.
 *
 * Detection (both conditions required, so the affordance only appears when
 * the rendering is actually broken):
 * 1. The message's API text has an odd fence-delimiter count (./fences.ts) —
 *    a fence never closes;
 * 2. the rendered message shows the runaway symptom: a single <pre> holds
 *    the majority of the message's visible text.
 *
 * Repair — chosen approach: a full own-UI re-render, appended INSIDE the
 * message as a clearly-labeled panel ("display only — original above"),
 * parsed from the API markdown by ./markdown.ts (textContent-only, own copy
 * of the mini-window pattern — features never import each other). The
 * unmatched fence is treated as text: content before it renders normally, the
 * delimiter line is shown literally as a marked divider, and the swallowed
 * tail renders as the markdown it was written as. Toggleable via the chip or
 * the panel's ✕; the panel also offers "copy corrected markdown" (fences
 * balanced) — the graceful-degrade path is thereby always present even if the
 * re-render reads poorly for some exotic message.
 *
 * What is NEVER done: claude's own DOM/text is not mutated, hidden, or
 * restyled — the chip and panel are additive owned nodes (answer-toolbar
 * attach pattern), removed by toggle/teardown, and the stored message is
 * untouched. dom-matcher safety: we attach only AFTER the answer's uuid is
 * resolved and cached on the element (`data-cc-uuid`), so the panel's extra
 * innerText can never poison a probe — after any virtualizer re-render both
 * the cache and the panel are gone together and matching restarts clean. The
 * chip's label renders via ::before content:attr() (zero innerText); the
 * panel's content is necessarily visible text, which the cached-uuid guard
 * covers.
 *
 * Toggle: settings.fenceFixerOn (gear "Repair" row + palette), reacted to
 * via storage.onSettingsChanged — no feature imports.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl } from "@/ui/root";
import { scanFences, splitAtUnmatchedFence, correctedMarkdown } from "./fences";
import { renderMarkdown } from "./markdown";

const OWNER = "fence-fixer";

const SWEEP_MS = 900;
const FLASH_MS = 1400;
/** The runaway symptom: one <pre> holding at least this share of the
 *  message's rendered text. */
const RUNAWAY_PRE_SHARE = 0.4;
/** Ignore trivial messages — a tiny broken block isn't worth a panel. */
const MIN_TEXT_LEN = 120;

/** lucide "wrench" — matches claude's icon style (stroke: currentColor). */
const ICON_WRENCH =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
const ICON_COPY =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_X =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export const fenceFixer: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "conversation",

  async mount(ctx: FeatureContext) {
    let on = true;
    /** uuids whose repair panel is currently open (survives re-renders). */
    const openUuids = new Set<string>();
    let flashGen = 0;

    // Make sure the API index (uuid + text source) is being built.
    void ctx.conversation.ensure();

    const apiText = (uuid: string): string | null => {
      const m = ctx.conversation.current()?.messages.find((msg) => msg.uuid === uuid);
      return m ? m.text : null;
    };

    // ---- detection --------------------------------------------------------------
    /** The rendered runaway symptom — one <pre> dominating the message.
     *  Companion-owned nodes (our open panel!) are excluded from BOTH sides
     *  of the ratio, otherwise opening the panel would dilute the total and
     *  flip detection off → an open/close oscillation. */
    const looksRunaway = (el: HTMLElement): boolean => {
      let total = (el.textContent ?? "").length;
      for (const own of el.querySelectorAll(":scope > [data-cc-owner]")) {
        total -= (own.textContent ?? "").length;
      }
      if (total < MIN_TEXT_LEN) return false;
      let biggest = 0;
      for (const pre of el.querySelectorAll("pre")) {
        // Skip our own panel's code blocks.
        if (pre.closest("[data-cc-owner]")) continue;
        biggest = Math.max(biggest, (pre.textContent ?? "").length);
      }
      return biggest / total >= RUNAWAY_PRE_SHARE;
    };

    const isBroken = (el: HTMLElement, uuid: string): boolean => {
      const text = apiText(uuid);
      if (!text || text.length < MIN_TEXT_LEN) return false;
      if (scanFences(text).count % 2 === 0) return false;
      return looksRunaway(el);
    };

    // ---- panel ---------------------------------------------------------------
    const buildPanel = (uuid: string): HTMLElement | null => {
      const text = apiText(uuid);
      if (text === null) return null;
      const split = splitAtUnmatchedFence(text);

      const panel = ownedEl("section", {
        owner: OWNER,
        className: "cc-ff-panel",
        attrs: { "data-cc-uuid-for": uuid, "aria-label": "Fixed formatting (display only)" },
      });

      const head = ownedEl("div", { owner: OWNER, className: "cc-ff-head" });
      const title = ownedEl("span", {
        owner: OWNER,
        className: "cc-ff-title",
        text: "Fixed formatting — display only, the original answer above is untouched",
      });
      const copyBtn = ownedEl("button", {
        owner: OWNER,
        className: "cc-ff-copy",
        attrs: {
          type: "button",
          title: "Copy this answer's markdown with the broken fence corrected",
          "aria-label": "Copy corrected markdown",
        },
      });
      copyBtn.innerHTML = ICON_COPY; // static, trusted markup
      copyBtn.append(ownedEl("span", { owner: OWNER, text: "Copy corrected markdown" }));
      const closeBtn = ownedEl("button", {
        owner: OWNER,
        className: "cc-ff-close",
        attrs: { type: "button", title: "Hide the re-render", "aria-label": "Hide the re-render" },
      });
      closeBtn.innerHTML = ICON_X; // static, trusted markup
      head.append(title, copyBtn, closeBtn);
      panel.append(head);

      const body = ownedEl("div", { owner: OWNER, className: "cc-ff-body" });
      if (split) {
        if (split.before.trim()) body.append(renderMarkdown(OWNER, split.before));
        body.append(
          ownedEl("div", {
            owner: OWNER,
            className: "cc-ff-fencemark",
            text: `unclosed fence “${split.fenceLine.trim()}” — treated as text, the content below rendered normally`,
          }),
        );
        if (split.after.trim()) body.append(renderMarkdown(OWNER, split.after));
      } else {
        // Detection raced a re-fetch and the fences balance now — degrade to
        // an honest note; the copy button still works on the current text.
        body.append(
          ownedEl("p", {
            owner: OWNER,
            className: "cc-ff-fencemark",
            text: "This message's fences look balanced now — nothing to repair.",
          }),
        );
      }
      panel.append(body);
      return panel;
    };

    const copyText = async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Clipboard API can be denied without document focus — legacy fallback.
        try {
          const ta = ownedEl("textarea", { owner: OWNER, className: "cc-ff-clip" });
          ta.value = text;
          ctx.root.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          ta.remove();
          return ok;
        } catch {
          return false;
        }
      }
    };

    // ---- per-answer attach (pins/answer-toolbar pattern) ------------------------
    const equip = (el: HTMLElement): void => {
      // uuid must resolve+cache BEFORE anything is attached (see header).
      const uuid = el.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(el);
      if (!uuid) return;

      const chip = el.querySelector<HTMLElement>(":scope > .cc-ff-chip");
      const panel = el.querySelector<HTMLElement>(":scope > .cc-ff-panel");

      if (!isBroken(el, uuid)) {
        // Healed (edit/re-render) — withdraw everything for this answer.
        chip?.remove();
        panel?.remove();
        openUuids.delete(uuid);
        return;
      }

      if (!chip) {
        const btn = ownedEl("button", {
          owner: OWNER,
          className: "cc-ff-chip",
          attrs: {
            type: "button",
            "data-cc-label": "Fix formatting",
            title:
              "A broken code fence made the rest of this answer render as code — show a corrected re-render (display only)",
            "aria-label": "Fix formatting — show a corrected re-render of this answer",
            "aria-pressed": openUuids.has(uuid) ? "true" : "false",
          },
        });
        btn.innerHTML = ICON_WRENCH; // static, trusted markup
        el.append(btn);
      }

      // Keep the panel's presence in sync with the toggle state (re-renders
      // drop it; the sweep restores it).
      if (openUuids.has(uuid) && !panel) {
        const built = buildPanel(uuid);
        if (built) el.append(built);
      } else if (!openUuids.has(uuid) && panel) {
        panel.remove();
      }
    };

    const answers = (): HTMLElement[] =>
      ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);

    const removeAll = (): void => {
      for (const el of document.querySelectorAll(
        `.cc-ff-chip[data-cc-owner="${OWNER}"], .cc-ff-panel[data-cc-owner="${OWNER}"]`,
      )) {
        el.remove();
      }
    };

    // ---- delegated clicks (survive virtualization re-renders) ------------------
    ctx.listen(document, "click", (ev: MouseEvent) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (!t) return;

      const chip = t.closest<HTMLButtonElement>(`.cc-ff-chip[data-cc-owner="${OWNER}"]`);
      if (chip) {
        ev.stopPropagation();
        const el = ctx.selectors.closest<HTMLElement>("assistantMessage", chip);
        const uuid = el ? (el.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(el)) : null;
        if (!el || !uuid) return; // index not ready — quietly do nothing
        if (openUuids.has(uuid)) {
          openUuids.delete(uuid);
          chip.setAttribute("aria-pressed", "false");
          el.querySelector(":scope > .cc-ff-panel")?.remove();
        } else {
          openUuids.add(uuid);
          chip.setAttribute("aria-pressed", "true");
          const built = buildPanel(uuid);
          if (built) {
            el.append(built);
            built.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        }
        return;
      }

      const close = t.closest<HTMLButtonElement>(`.cc-ff-close[data-cc-owner="${OWNER}"]`);
      if (close) {
        ev.stopPropagation();
        const panel = close.closest<HTMLElement>(".cc-ff-panel");
        if (!panel) return;
        const uuid = panel.getAttribute("data-cc-uuid-for");
        if (uuid) {
          openUuids.delete(uuid);
          ctx.selectors
            .closest<HTMLElement>("assistantMessage", panel)
            ?.querySelector(`:scope > .cc-ff-chip`)
            ?.setAttribute("aria-pressed", "false");
        }
        panel.remove();
        return;
      }

      const copy = t.closest<HTMLButtonElement>(`.cc-ff-copy[data-cc-owner="${OWNER}"]`);
      if (copy) {
        ev.stopPropagation();
        const uuid = copy.closest<HTMLElement>(".cc-ff-panel")?.getAttribute("data-cc-uuid-for");
        const text = uuid ? apiText(uuid) : null;
        if (text === null) return; // quiet
        void copyText(correctedMarkdown(text)).then((ok) => {
          if (ctx.signal.aborted || !copy.isConnected) return;
          const ic = copy.querySelector("svg");
          if (!ic) return;
          const prev = ic.outerHTML;
          copy.classList.add(ok ? "cc-ff-done" : "cc-ff-fail");
          ic.outerHTML = ICON_CHECK; // static, trusted markup
          const gen = String(++flashGen);
          copy.dataset["ccFlash"] = gen;
          ctx.setTimeout(() => {
            if (copy.dataset["ccFlash"] !== gen || !copy.isConnected) return;
            copy.querySelector("svg")?.remove();
            copy.insertAdjacentHTML("afterbegin", prev); // our own trusted SVG
            copy.classList.remove("cc-ff-done", "cc-ff-fail");
          }, FLASH_MS);
        });
      }
    });

    // ---- settings toggle (gear "Repair" row / palette — no feature imports) ---
    const settings = await ctx.storage.getSettings();
    if (ctx.signal.aborted) return;
    on = settings.fenceFixerOn;

    ctx.onCleanup(
      ctx.storage.onSettingsChanged((s) => {
        if (s.fenceFixerOn === on) return;
        on = s.fenceFixerOn;
        if (!on) removeAll();
      }),
    );

    // ---- maintenance sweep (pins pattern) --------------------------------------
    const sweep = (): void => {
      if (!on) return;
      for (const el of answers()) equip(el);
    };
    ctx.setInterval(sweep, SWEEP_MS);
    ctx.on("conversation:updated", sweep);
    sweep();

    // Runtime disposal also sweeps every [data-cc-owner="fence-fixer"] node;
    // this keeps teardown explicit.
    ctx.onCleanup(removeAll);
  },
};
