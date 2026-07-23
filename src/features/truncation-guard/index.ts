/**
 * Truncation guard — Output repair. Conversation scope.
 *
 * Detects when Claude's LAST answer got cut off and offers a one-click
 * "Continue" that asks Claude to pick up exactly where it stopped.
 *
 * Detection (never while streaming; always from the API-indexed text, never
 * scraped from the DOM):
 * - unclosed code fence / dangling mid-sentence ending → ./detect.ts (pure,
 *   conservative heuristics);
 * - manual stop: a capture-phase click on claude's stop button (selector from
 *   core/selectors.ts) marks the answer that the next `generation:end`
 *   produces as "stopped early" — core/generation.ts cannot tell a stop-click
 *   end from a natural end, so the click itself is the signal.
 *
 * Affordance: a subtle row appended INSIDE the last answer (additive owned
 * node, pins/answer-toolbar attach pattern; swept on teardown). Every visible
 * string renders via ::before content:attr() or inline SVG so the row adds
 * ZERO characters to the answer's innerText — dom-matcher probes, folding
 * fold-heads and clipboard stay clean (innerText-invisible technique). It only attaches
 * AFTER the answer's uuid is resolved+cached, and disappears when a newer
 * message arrives, when streaming starts, or when dismissed (per-uuid).
 *
 * "Continue" (EXPLICIT click only — never auto-sent): inserts a short
 * continue prompt via ctx.composer.insertText, then fires claude's OWN send
 * button (the undo-send "fire" technique — no invented endpoints; if
 * undo-send is armed its countdown intercepts this click like any other send,
 * which is correct). If the composer already holds a draft we do NOT touch or
 * send it — the row flashes "clear your draft first" instead (never
 * destroy user input, never block claude.ai).
 *
 * Toggle: settings.truncationGuardOn (gear "Repair" row + palette), reacted
 * to via storage.onSettingsChanged — no feature imports.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl } from "@/ui/root";
import { detectTruncation, reasonLabel } from "./detect";

const OWNER = "truncation-guard";

const SWEEP_MS = 900;
const BLOCKED_FLASH_MS = 1800;
/** A stop-click older than this cannot explain a generation:end. */
const STOP_CLICK_WINDOW_MS = 20_000;
/** Grace before firing send — lets React enable the send button post-insert. */
const FIRE_DELAY_MS = 180;

const CONTINUE_PROMPT = "Please continue exactly where you left off.";

/** Same aria-label heuristic as undo-send's fire path (documented there: the
 *  send button lookup belongs in core/selectors.ts eventually). */
const SEND_LABEL_RE = /send/i;

/** lucide "triangle-alert" — matches claude's icon style (stroke: currentColor). */
const ICON_WARN =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
/** lucide "x" — dismiss. */
const ICON_X =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

interface Target {
  uuid: string;
  reason: "fence" | "dangling" | "stopped";
}

export const truncationGuard: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "conversation",

  async mount(ctx: FeatureContext) {
    let on = true;
    let working = false;
    let stopClickAt: number | null = null;
    /** uuids the stop button was pressed on (manual-stop reason). */
    const stopped = new Set<string>();
    /** uuids the user dismissed the affordance on (session memory). */
    const dismissed = new Set<string>();
    let target: Target | null = null;
    let blockedGen = 0;

    // Make sure the API index (uuid + text source) is being built.
    void ctx.conversation.ensure();

    // ---- streaming state (core detector only) -------------------------
    ctx.on("generation:start", () => {
      working = true;
      removeRow();
    });
    ctx.on("generation:end", () => {
      working = false;
      // The store refetches on generation:end and emits conversation:updated;
      // recompute() runs there, once the fresh index exists.
    });

    // Manual-stop signal: a capture click on claude's stop button. The click
    // is observed only — never prevented (fail open).
    ctx.listen(
      document,
      "click",
      (ev: MouseEvent) => {
        const t = ev.target instanceof Element ? ev.target : null;
        if (!t || t.closest("#cc-root")) return;
        if (ctx.selectors.closest("stopButton", t)) stopClickAt = Date.now();
      },
      { capture: true },
    );

    // ---- detection over the API index ----------------------------------------
    const recompute = (): void => {
      const index = ctx.conversation.current();
      const last = index?.messages[index.messages.length - 1];
      // Only the LAST message, and only when Claude spoke last.
      if (!index || !last || last.sender !== "assistant") {
        target = null;
        removeRow();
        return;
      }
      // A pending stop-click explains this answer's end → "stopped early".
      if (stopClickAt !== null && Date.now() - stopClickAt <= STOP_CLICK_WINDOW_MS) {
        stopped.add(last.uuid);
        stopClickAt = null;
      }
      const reason = stopped.has(last.uuid) ? "stopped" : detectTruncation(last.text);
      target = reason ? { uuid: last.uuid, reason } : null;
      if (!target) removeRow();
    };
    ctx.on("conversation:indexed", recompute);
    ctx.on("conversation:updated", recompute);

    // ---- affordance row ---------------------------------------------------------
    const removeRow = (): void => {
      for (const el of document.querySelectorAll(`.cc-tg[data-cc-owner="${OWNER}"]`)) el.remove();
    };

    const buildRow = (reason: Target["reason"]): HTMLElement => {
      const row = ownedEl("div", {
        owner: OWNER,
        className: "cc-tg",
        attrs: { "data-cc-reason": reason },
      });
      const btn = ownedEl("button", {
        owner: OWNER,
        className: "cc-tg-btn",
        attrs: {
          type: "button",
          "data-cc-label": `Looks cut off (${reasonLabel(reason)}) — continue`,
          title: "Ask Claude to continue exactly where it left off",
          "aria-label": `This answer looks cut off (${reasonLabel(reason)}). Continue where it left off`,
        },
      });
      btn.innerHTML = ICON_WARN; // static, trusted markup (bundled constant)
      const x = ownedEl("button", {
        owner: OWNER,
        className: "cc-tg-x",
        attrs: {
          type: "button",
          title: "Not cut off — dismiss",
          "aria-label": "Not cut off — dismiss",
        },
      });
      x.innerHTML = ICON_X; // static, trusted markup
      row.append(btn, x);
      return row;
    };

    const equip = (): void => {
      if (!on || working || !target || dismissed.has(target.uuid)) return;
      // Last rendered answer inside the thread (thread-only guard + CSS net).
      const answers = ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);
      const el = answers[answers.length - 1];
      if (!el) return;
      // uuid must resolve+cache BEFORE we attach (keeps dom-matcher probes
      // clean — the row itself adds zero innerText, but the rule stays).
      const uuid = el.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(el);
      if (uuid !== target.uuid) {
        removeRow();
        return;
      }
      const existing = el.querySelector<HTMLElement>(":scope > .cc-tg");
      if (existing?.getAttribute("data-cc-reason") === target.reason) return;
      removeRow(); // never two rows; also rebuilds when the reason changed
      el.append(buildRow(target.reason));
    };

    // ---- the Continue fire path (undo-send technique — claude's own send) -----
    const findSendButton = (): HTMLButtonElement | null => {
      for (const b of Array.from(
        document.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
      )) {
        if (b.closest("#cc-root")) continue;
        if (!SEND_LABEL_RE.test(b.getAttribute("aria-label") ?? "")) continue;
        if (b.disabled) continue;
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return b;
      }
      return null;
    };

    const fire = (): void => {
      const sendBtn = findSendButton();
      if (sendBtn) {
        // A real click on claude's real button — every native side effect
        // (and an armed undo-send countdown) applies as usual.
        sendBtn.click();
      } else {
        // Fail-open fallback: replay a native Enter into the composer. If
        // even this misses, the prompt simply sits in the draft — nothing
        // is lost and nothing is blocked.
        ctx.composer
          .find()
          ?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              bubbles: true,
              cancelable: true,
            }),
          );
      }
    };

    const continueAnswer = (btn: HTMLButtonElement): void => {
      if (working) return;
      if (ctx.composer.readDraft().trim()) {
        // Never clobber or auto-send the user's own draft — tell them why.
        const prev = btn.getAttribute("data-cc-label") ?? "";
        btn.setAttribute("data-cc-label", "clear your draft first");
        btn.classList.add("cc-tg-blocked");
        const gen = String(++blockedGen);
        btn.dataset["ccBlockedGen"] = gen;
        ctx.setTimeout(() => {
          if (btn.dataset["ccBlockedGen"] !== gen || !btn.isConnected) return;
          btn.setAttribute("data-cc-label", prev);
          btn.classList.remove("cc-tg-blocked");
        }, BLOCKED_FLASH_MS);
        ctx.composer.find()?.focus();
        return;
      }
      if (!ctx.composer.insertText(CONTINUE_PROMPT)) return; // quiet
      removeRow();
      // Give React a tick to enable the send button for the new draft.
      ctx.setTimeout(fire, FIRE_DELAY_MS);
    };

    // Delegated clicks — survive virtualization re-renders untouched.
    ctx.listen(document, "click", (ev: MouseEvent) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (!t) return;
      const inRow = t.closest<HTMLElement>(`.cc-tg[data-cc-owner="${OWNER}"]`);
      if (!inRow) return;
      ev.stopPropagation();
      const dismiss = t.closest<HTMLButtonElement>(".cc-tg-x");
      if (dismiss) {
        if (target) dismissed.add(target.uuid);
        removeRow();
        return;
      }
      const btn = t.closest<HTMLButtonElement>(".cc-tg-btn");
      if (btn) continueAnswer(btn);
    });

    // ---- settings toggle (gear "Repair" row / palette — no feature imports) ---
    const settings = await ctx.storage.getSettings();
    if (ctx.signal.aborted) return;
    on = settings.truncationGuardOn;

    ctx.onCleanup(
      ctx.storage.onSettingsChanged((s) => {
        if (s.truncationGuardOn === on) return;
        on = s.truncationGuardOn;
        if (!on) removeRow();
      }),
    );

    // ---- maintenance sweep (pins pattern) --------------------------------------
    ctx.setInterval(equip, SWEEP_MS);
    recompute();
    equip();

    // Runtime disposal also sweeps every [data-cc-owner="truncation-guard"]
    // node; this keeps teardown explicit.
    ctx.onCleanup(removeRow);
  },
};
