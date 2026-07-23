/**
 * Undo-send — Tier 3, session scope.
 *
 * A configurable delay window to cancel a just-sent message. The countdown
 * "fire" path is implemented via claude's own send button (no SSE endpoint
 * of our own; clicking the real button keeps every native side effect
 * intact) and guarded against double-send.
 *
 * Anatomy:
 * - A timer icon in the composer-inline group — SHARED CONTRACT with the
 *   usage feature: one group `#cc-composer-grp` (created by whichever of the
 *   two mounts/re-places first) inserted inside claude's composer action row
 *   immediately before the voice/dictation button group; each feature owns
 *   its own `.cc-composer-slot` inside it (`#cc-undo-inline`, `#cc-usage-
 *   inline`), ordered [undo][usage]. Re-placed on a ctx interval because
 *   React re-renders drop foreign nodes; if the row is never found the
 *   feature is quietly absent.
 * - Hover/click dropdown Off/2/3/5/10 s; choice persists in
 *   settings.undoDelaySeconds (storage.sync — migrated from the legacy
 *   `cc-undo-delay`).
 * - When armed: Enter-without-Shift inside the composer and clicks on claude's
 *   send button are intercepted (capture phase) → countdown pill
 *   "⏱ sending in Ns · Esc to cancel" with a ■ cancel button. Esc / ■ cancel
 *   and the draft is preserved (we prevented the send; the text never left
 *   the composer).
 * - Countdown-zero → click claude's REAL send button. Double-send guards:
 *   `counting` blocks re-entry, `firing` lets the real send pass the
 *   interceptors and blocks a second fire until it settles.
 * - FAIL OPEN: any bug that keeps us from intercepting means the send simply
 *   goes through natively — never block a send on companion bugs.
 *
 * NOTE: the send/voice button lookups are aria-label heuristics local to this
 * file; they belong in core/selectors.ts the next time that file is revised.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl, setGeometry } from "@/ui/root";

const ID = "undo-send";

const DELAY_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [0, "Off"],
  [2, "2s"],
  [3, "3s"],
  [5, "5s"],
  [10, "10s"],
];

/** lucide "timer" — matches claude's icon style (stroke: currentColor). */
const TIMER_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>';

// Claude-facing lookups (see file header note re: selectors.ts freeze).
const SEND_LABEL_RE = /send/i;
const VOICE_LABEL_RE = /voice|dictat|record/i;
const VOICE_BTN_CSS =
  'button[aria-label*="voice" i], button[aria-label*="dictat" i], button[aria-label*="record" i]';
const COMPOSER_ROW_CSS = ".relative.flex.items-center.w-full";

/** True when a voice-labeled button actually belongs to the COMPOSER — i.e.
 *  a near ancestor also contains the contenteditable input. Without this,
 *  any list row with a voice/recording label (chats & tasks page) matches
 *  and the whole inline group glues itself onto that row. */
function isComposerVoiceButton(b: HTMLElement): boolean {
  let node: HTMLElement | null = b;
  for (let i = 0; i < 8 && node; i++) {
    const tag = node.tagName;
    if (tag === "MAIN" || tag === "ASIDE" || tag === "BODY") return false;
    if (node.querySelector('div[contenteditable="true"]')) return true;
    node = node.parentElement;
  }
  return false;
}

/** The composer action row that hosts the mic/voice group. */
function findComposerActionRow(): HTMLElement | null {
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]"))) {
    if (!VOICE_LABEL_RE.test(b.getAttribute("aria-label") ?? "")) continue;
    if (!isComposerVoiceButton(b)) continue;
    const row = b.closest<HTMLElement>(COMPOSER_ROW_CSS);
    if (row) return row;
    // Fallback: four levels up from the voice button.
    const up = b.parentElement?.parentElement?.parentElement?.parentElement ?? null;
    if (up) return up;
  }
  return null;
}

/** The row's direct child containing the voice button (insertion anchor). */
function voiceGroupIn(row: HTMLElement): Element | null {
  for (const child of Array.from(row.children)) {
    if (child.querySelector(VOICE_BTN_CSS)) return child;
  }
  return null;
}

/**
 * The shared composer-inline group (contract with the usage feature): find or
 * create `#cc-composer-grp` and keep it parked in the action row before the
 * voice group. Returns null when the row isn't available.
 */
function ensureComposerGroup(creatorId: string): HTMLElement | null {
  let group = document.getElementById("cc-composer-grp");
  if (!group) {
    group = ownedEl("div", { owner: creatorId, attrs: { id: "cc-composer-grp" } });
  }
  const row = findComposerActionRow();
  if (!row) return null;
  if (group.parentElement !== row) {
    try {
      row.insertBefore(group, voiceGroupIn(row));
    } catch {
      return null; // row mid-re-render — retry next tick
    }
  }
  return group;
}

export const undoSend: FeatureModule = {
  id: ID,
  tier: 3,
  scope: "session",

  mount(ctx: FeatureContext) {
    let delaySeconds = 0;
    let counting = false;
    let deadline = 0;
    let firing = false;
    /** Popover grace-period close (ctx timeouts aren't cancellable — the
     *  callback checks this timestamp instead). */
    let popHideAt: number | null = null;

    // ---- inline slot + timer button (composer-inline group contract) ----
    const slot = ownedEl("div", {
      owner: ID,
      className: "cc-composer-slot",
      attrs: { id: "cc-undo-inline" },
    });
    const btn = ownedEl("button", {
      owner: ID,
      className: "cc-inline-btn",
      attrs: {
        id: "cc-undo-btn",
        type: "button",
        title: "Undo-send delay",
        "aria-label": "Undo-send delay",
      },
    });
    btn.innerHTML = TIMER_SVG;
    slot.appendChild(btn);
    ctx.onCleanup(() => slot.remove());

    // ---- delay dropdown (top-level UI → under #cc-root) ----
    const pop = ownedEl("div", {
      owner: ID,
      className: "cc-popover cc-undo-pop",
      attrs: { id: "cc-pop-undo", role: "menu" },
    });
    pop.style.display = "none";
    ctx.root.appendChild(pop);
    ctx.onCleanup(() => pop.remove());

    const syncArmed = (): void => {
      btn.classList.toggle("cc-armed", delaySeconds > 0);
    };

    const renderOptions = (): void => {
      pop.textContent = "";
      for (const [value, text] of DELAY_OPTIONS) {
        const selected = value === delaySeconds;
        const opt = ownedEl("div", {
          owner: ID,
          className: "cc-undo-opt" + (selected ? " cc-sel" : ""),
          text: text + (selected ? "  ✓" : ""),
          attrs: { role: "menuitemradio", "aria-checked": String(selected), "data-cc-delay": String(value) },
        });
        pop.appendChild(opt);
      }
    };

    const openPop = (): void => {
      popHideAt = null;
      renderOptions();
      const r = btn.getBoundingClientRect();
      setGeometry(pop, { left: Math.max(8, r.left), top: r.top - 8, transform: "translateY(-100%)" });
      pop.style.display = "flex";
    };

    const scheduleHide = (ms: number): void => {
      popHideAt = Date.now() + ms;
      ctx.setTimeout(() => {
        if (popHideAt !== null && Date.now() >= popHideAt) {
          pop.style.display = "none";
          popHideAt = null;
        }
      }, ms + 40);
    };

    // Hover opens (desktop); click also opens (touch — no hover there). The
    // click must NOT toggle: mouseenter has usually opened the dropdown by
    // the time the click lands. Closing = outside mousedown / mouseleave
    // grace / option pick.
    ctx.listen(btn, "mouseenter", openPop);
    ctx.listen(btn, "click", openPop);
    ctx.listen(btn, "mouseleave", () => scheduleHide(350));
    ctx.listen(pop, "mouseenter", () => {
      popHideAt = null;
    });
    ctx.listen(pop, "mouseleave", () => scheduleHide(300));
    // Option select — delegated so re-renders don't stack listeners.
    ctx.listen(pop, "click", (ev: MouseEvent) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      const opt = target.closest<HTMLElement>(".cc-undo-opt");
      if (!opt) return;
      const value = Number.parseInt(opt.getAttribute("data-cc-delay") ?? "", 10);
      if (!Number.isFinite(value) || value < 0) return;
      delaySeconds = value;
      void ctx.storage.setSetting("undoDelaySeconds", value);
      syncArmed();
      renderOptions();
      scheduleHide(250);
    });
    // Outside mousedown closes the dropdown.
    ctx.listen(document, "mousedown", (ev: MouseEvent) => {
      if (pop.style.display === "none") return;
      const target = ev.target;
      if (target instanceof Element && (target.closest("#cc-pop-undo") || target.closest("#cc-undo-inline")))
        return;
      pop.style.display = "none";
      popHideAt = null;
    });

    // ---- countdown pill ----
    const chip = ownedEl("div", {
      owner: ID,
      className: "cc-undo-chip",
      attrs: { id: "cc-undo-chip", role: "status" },
    });
    const chipText = ownedEl("span", { owner: ID, attrs: { id: "cc-undo-txt" } });
    const cancelBtn = ownedEl("button", {
      owner: ID,
      className: "cc-undo-cancel",
      text: "■",
      attrs: { type: "button", title: "Cancel send (Esc)", "aria-label": "Cancel send" },
    });
    chip.append(chipText, cancelBtn);
    chip.style.display = "none";
    ctx.root.appendChild(chip);
    ctx.onCleanup(() => chip.remove());

    const positionChip = (): void => {
      const box = ctx.composer.container();
      const r = (box ?? document.body).getBoundingClientRect();
      setGeometry(chip, { left: Math.max(8, r.right - 240), top: Math.max(8, r.top - 44) });
    };

    const hideChip = (): void => {
      chip.style.display = "none";
      counting = false;
    };

    /** Cancel: draft is preserved — the send was prevented, the text never
     *  left the composer. */
    const cancel = (): void => {
      hideChip();
    };
    ctx.listen(cancelBtn, "click", (ev: MouseEvent) => {
      ev.stopPropagation();
      cancel();
    });

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

    /** The fire path: click
     *  claude's real send button while `firing` lets it pass our
     *  interceptors. Double-send guarded by `counting`/`firing`. */
    const fire = (): void => {
      if (firing) return;
      hideChip();
      firing = true;
      const sendBtn = findSendButton();
      if (sendBtn) {
        sendBtn.click();
      } else {
        // Fail-open fallback: replay a native Enter into the composer (our
        // keydown interceptor passes it through while `firing` is set). If
        // even this misses, the draft stays intact — nothing is lost.
        ctx.composer.find()?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
        );
      }
      ctx.setTimeout(() => {
        firing = false;
      }, 800);
    };

    const startCountdown = (): void => {
      if (counting || firing || delaySeconds <= 0) return;
      counting = true;
      deadline = Date.now() + delaySeconds * 1000;
      positionChip();
      chipText.textContent = `⏱ sending in ${delaySeconds}s · Esc to cancel`;
      chip.style.display = "flex";
    };

    // One persistent ticker drives the countdown (ctx intervals aren't
    // individually cancellable — state flags gate it instead).
    ctx.setInterval(() => {
      if (!counting) return;
      const left = deadline - Date.now();
      if (left <= 0) {
        fire();
        return;
      }
      chipText.textContent = `⏱ sending in ${Math.ceil(left / 1000)}s · Esc to cancel`;
      positionChip();
    }, 200);

    // ---- interceptors (capture phase; every guard fails OPEN) ----
    ctx.listen(
      document,
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.key === "Escape" && counting) {
          ev.preventDefault();
          ev.stopPropagation();
          cancel();
          return;
        }
        if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
        if (delaySeconds <= 0 || firing) return;
        const composer = ctx.composer.find();
        if (!composer || !(ev.target instanceof Node) || !composer.contains(ev.target)) return;
        if (counting) {
          // A send is already pending — swallow the repeat Enter so it can't
          // double-send (the pill says Esc to cancel).
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        if (!ctx.composer.readDraft().trim()) return;
        ev.preventDefault();
        ev.stopPropagation();
        startCountdown();
      },
      { capture: true },
    );

    ctx.listen(
      document,
      "click",
      (ev: MouseEvent) => {
        if (delaySeconds <= 0 || firing) return;
        const target = ev.target;
        if (!(target instanceof Element)) return;
        if (target.closest("#cc-root") || target.closest("#cc-composer-grp")) return;
        const button = target.closest("button");
        if (!button) return;
        if (!SEND_LABEL_RE.test(button.getAttribute("aria-label") ?? "")) return;
        if (counting) {
          // A send is already pending — swallow the click (no double-send).
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        if (!ctx.composer.readDraft().trim()) return;
        ev.preventDefault();
        ev.stopPropagation();
        startCountdown();
      },
      { capture: true },
    );

    // ---- settings (persisted delay; popup ↔ content via storage.onChanged) ----
    void ctx.storage.getSettings().then((s) => {
      if (ctx.signal.aborted) return;
      delaySeconds = s.undoDelaySeconds;
      syncArmed();
    });
    ctx.onCleanup(
      ctx.storage.onSettingsChanged((s) => {
        delaySeconds = s.undoDelaySeconds;
        syncArmed();
      }),
    );

    // ---- composer-inline placement (shared contract with usage) ----
    const place = (): void => {
      const group = ensureComposerGroup(ID);
      if (!group) {
        if (slot.parentElement) slot.remove();
        return;
      }
      if (slot.parentElement !== group) group.appendChild(slot);
      // Contract order inside the group: [undo][usage].
      const usageSlot = document.getElementById("cc-usage-inline");
      if (
        usageSlot &&
        usageSlot.parentElement === group &&
        slot.nextElementSibling !== usageSlot
      ) {
        group.insertBefore(slot, usageSlot);
      }
    };
    ctx.setInterval(place, 700);
    place();
  },
};
