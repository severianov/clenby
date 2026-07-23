/**
 * Answer toolbar — Per-answer tools. Conversation scope.
 *
 * A compact hover/focus toolbar at the top-right of every assistant answer,
 * attached per-message exactly like pins (additive owned node, maintenance
 * sweep, delegated clicks, swept on teardown — claude's DOM is never
 * restructured). Every action drives an EXISTING feature; this module owns no
 * copy of their logic:
 *
 * - Pin        → bus "ui:pin-toggle" (the pins feature toggles + persists —
 *   this toolbar is the single pin entry point since the standalone gutter
 *   button was removed). The button REFLECTS state: pins broadcasts the full
 *   set via "pins:changed" (once on load, again on every toggle) and this
 *   toolbar paints each rendered answer's Pin button active/inactive off
 *   that — no cross-feature imports, no storage re-reads mid-write. The
 *   cold-start read comes from the same ctx.storage.conv "pins" key the
 *   outline uses (a pins:changed that lands first always wins).
 * - Copy       → self-contained: serializes THIS answer through the shared
 *   cleanExportBody serializer and writes it to the clipboard (Clipboard API
 *   with the usual hidden-textarea execCommand fallback). No bus event.
 * - Pin on top → bus "ui:mini-window-popout" with THIS answer's uuid — a
 *   TOGGLE: the mini-window feature adds/removes the answer's card in the
 *   always-on-top PiP window. The button REFLECTS state exactly like Pin
 *   does: mini-window broadcasts the full popped-out uuid set via
 *   "mini-window:changed" (on every change and again on
 *   "conversation:indexed" for cold starts) and this toolbar paints the
 *   button active/inactive off that — so a mislaid floating window is always
 *   one click from closed, right on the message it came from.
 * - Add to note→ bus "ui:note-append" (the notes feature files the snippet as
 *   a new note for this conversation).
 * - Send to Claude Code → opens a handle/scope popover and, on confirm, emits
 *   bus "bridge:send"; the claude-code-bridge feature assembles + pushes over
 *   the loopback WS (features never import each other). The button is INERT
 *   until ≥1 Claude Code session connects ("Start Claude Code and this lights
 *   up." — spec §3); it reflects live/inert off "bridge:changed".
 *
 * Click feedback: a brief ✓ (ok) / danger tint flash on the pressed button.
 * The flash is self-healing by construction — the resting face is DERIVED
 * (per-action icon; pin also derives label + active class from the pinned
 * set), never saved-and-restored, so a re-flash mid-flash or a React
 * detach/reattach can never strand a button in the flashed state. A
 * per-button generation stamp supersedes any pending clear before a new one
 * arms, the timed clear repaints even a disconnected node (it may be
 * reattached later), and the maintenance sweep repaints any expired flash
 * whose timer got swept. Everything is ctx-managed.
 *
 * Touch/keyboard: the toolbar is a non-essential duplicate of palette/gutter
 * actions, so hover-reveal is acceptable (project rules); it is additionally
 * revealed by :focus-within (buttons are real, tabbable buttons) and is
 * always visible on coarse-pointer devices (companion.css @media hover:none).
 *
 * The answer element is guaranteed a positioned ancestor + thread-only guard
 * by requesting a decorations gutter slot (left empty — companion.css hides
 * empty slots so the rail's flex gap is unaffected).
 *
 * Always on: the toolbar's optional toggle (settings.answerToolbarOn + its
 * gear-menu/palette entries) was deliberately removed — the
 * feature simply always runs.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl, setGeometry } from "@/ui/root";
import { cleanExportBody } from "@/shared/text";
import type { BridgeSession } from "@/shared/bridge-protocol";
import type { HandoffScope } from "@/shared/handoff";

const OWNER = "answer-toolbar";

const SWEEP_MS = 900;
const FLASH_MS = 1400;
const NOTE_SNIPPET_MAX = 700;

// Lucide-style line icons — static, trusted markup (bundled constants,
// stroke: currentColor; no emoji, matching the header-cluster convention).
const ICON_PIN =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
/** Same pin, filled — the "this answer IS pinned" face. */
const ICON_PIN_FILLED =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
const ICON_COPY =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const ICON_POPOUT =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const ICON_NOTE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>';
const ICON_CHECK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_SEND =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>';

type ToolbarAct = "pin" | "copy" | "popout" | "note" | "send";

/** Data-driven — adding an action is exactly one more row here. The pin and
 *  popout rows' labels/icons are the resting faces; paintPin()/paintPopout()
 *  own the active faces. */
const ACTIONS: ReadonlyArray<{ act: ToolbarAct; label: string; icon: string }> = [
  { act: "pin", label: "Pin this answer", icon: ICON_PIN },
  { act: "copy", label: "Copy this answer", icon: ICON_COPY },
  { act: "popout", label: "Pin on top — floating mini-window", icon: ICON_POPOUT },
  { act: "note", label: "Add a snippet of this answer to notes", icon: ICON_NOTE },
  { act: "send", label: "Send to Claude Code", icon: ICON_SEND },
];

const SEND_LABEL = "Send to Claude Code";
const SEND_INERT_LABEL = "Start Claude Code and this lights up.";

/** act → resting icon (pin's resting icon additionally depends on the
 *  pinned set — see restingFace()). */
const ACTION_ICONS: Record<ToolbarAct, string> = {
  pin: ICON_PIN,
  copy: ICON_COPY,
  popout: ICON_POPOUT,
  note: ICON_NOTE,
  send: ICON_SEND,
};

const PIN_LABEL = "Pin this answer";
const UNPIN_LABEL = "Unpin this answer";
const POPOUT_LABEL = "Pin on top — floating mini-window (stays over every tab)";
const UNPOPOUT_LABEL = "Unpin — remove this answer from the mini-window";

/** Snippet cut that PRESERVES line structure (clip() collapses newlines,
 *  which would flatten lists/headings inside a note). */
function snippetOf(text: string, max: number): string {
  const t = cleanExportBody(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const brk = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return (brk > max * 0.6 ? cut.slice(0, brk) : cut).trimEnd() + " …";
}

export const answerToolbar: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    // Make sure the API index (uuid + text source) is being built.
    void ctx.conversation.ensure();

    // ---- pinned-set mirror (bus-fed; storage only for the cold start) --------
    /** Mirror of the pins feature's set. null until the first source lands. */
    let pinnedSet: Set<string> | null = null;
    /** A live "pins:changed" broadcast beat the cold-start read — from then
     *  on the bus is the only truth (the async storage write may lag). */
    let pinsLive = false;

    const isPinned = (uuid: string): boolean => pinnedSet?.has(uuid) ?? false;

    const answers = (): HTMLElement[] =>
      ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);

    const uuidForButton = (btn: HTMLElement): string | null => {
      const el = ctx.selectors.closest<HTMLElement>("assistantMessage", btn);
      if (!el) return null;
      return el.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(el);
    };

    // ---- button faces ----------------------------------------------------------
    /** True while a click-feedback flash is showing on this button. */
    const isFlashed = (btn: HTMLElement): boolean => btn.dataset["ccFlash"] !== undefined;

    /** Paint the pin button's state face (active class + label always; the
     *  icon only when no flash is showing — the flash clear re-derives it). */
    const paintPin = (btn: HTMLButtonElement): void => {
      const uuid = uuidForButton(btn);
      const on = uuid !== null && isPinned(uuid);
      btn.classList.toggle("cc-atb-pinned", on);
      const label = on ? UNPIN_LABEL : PIN_LABEL;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      if (!isFlashed(btn)) btn.innerHTML = on ? ICON_PIN_FILLED : ICON_PIN; // static, trusted markup
    };

    /** Restore a button's DERIVED resting face (never a saved snapshot — a
     *  snapshot taken mid-flash is how buttons used to stick on ✓). */
    const restingFace = (btn: HTMLButtonElement): void => {
      const act = btn.dataset["ccAct"] as ToolbarAct | undefined;
      if (!act) return;
      if (act === "pin") {
        paintPin(btn);
      } else {
        btn.innerHTML = ACTION_ICONS[act]; // static, trusted markup
        if (act === "popout") paintPopout(btn); // active face is class/label-derived
        if (act === "send") paintSend(btn); // inert/live face is state-derived
      }
    };

    /** Every pin button in every rendered bar re-derives its face. */
    const repaintPins = (): void => {
      const sel = `.cc-atb[data-cc-owner="${OWNER}"] .cc-atb-btn[data-cc-act="pin"]`;
      for (const btn of document.querySelectorAll<HTMLButtonElement>(sel)) paintPin(btn);
    };

    // Live updates: the pins feature broadcasts the full set on every toggle
    // (from this toolbar or anywhere else) — repaint every rendered button.
    ctx.on("pins:changed", ({ pinned }) => {
      pinsLive = true;
      pinnedSet = new Set(pinned);
      repaintPins();
    });
    // Cold start: pins (mounted earlier) emitted its load broadcast before we
    // subscribed — read the same conv-scoped key it persists to. A live
    // broadcast that arrives first wins unconditionally.
    void ctx.storage.conv.get("pins").then((stored) => {
      if (ctx.signal.aborted || pinsLive) return;
      pinnedSet = new Set(stored);
      repaintPins();
    });

    // ---- popped-out-set mirror (bus-fed; session-live only, no storage) -------
    /** Mirror of the mini-window feature's popped-out uuid set. Session-scoped
     *  state with no persistence — the bus is the only source, and the
     *  producer re-broadcasts on "conversation:indexed" for our cold start. */
    let poppedSet = new Set<string>();

    const paintPopout = (btn: HTMLButtonElement): void => {
      const uuid = uuidForButton(btn);
      const on = uuid !== null && poppedSet.has(uuid);
      btn.classList.toggle("cc-atb-popped", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      const label = on ? UNPOPOUT_LABEL : POPOUT_LABEL;
      btn.title = label;
      btn.setAttribute("aria-label", label);
    };

    const repaintPopouts = (): void => {
      const sel = `.cc-atb[data-cc-owner="${OWNER}"] .cc-atb-btn[data-cc-act="popout"]`;
      for (const btn of document.querySelectorAll<HTMLButtonElement>(sel)) paintPopout(btn);
    };

    ctx.on("mini-window:changed", ({ uuids }) => {
      poppedSet = new Set(uuids);
      repaintPopouts();
    });

    // ================= Claude Code bridge — "Send to Claude Code" =============
    // Bus-fed state (the claude-code-bridge feature is the single producer);
    // this toolbar only lights/dims the button and hands off the chosen
    // handle+scope. The send is inert until ≥1 session connects (spec §3).
    let bridgeSessions: BridgeSession[] = [];
    let bridgeBound: string | null = null;

    const boundBridgeSession = (): BridgeSession | null =>
      bridgeSessions.find((s) => s.sessionId === bridgeBound) ?? null;

    /** send button face: greyed + inert with no session, live otherwise. */
    const paintSend = (btn: HTMLButtonElement): void => {
      const live = bridgeSessions.length > 0;
      btn.classList.toggle("cc-atb-inert", !live);
      btn.setAttribute("aria-disabled", live ? "false" : "true");
      const label = live ? SEND_LABEL : SEND_INERT_LABEL;
      btn.title = label;
      btn.setAttribute("aria-label", label);
    };
    const repaintSends = (): void => {
      const sel = `.cc-atb[data-cc-owner="${OWNER}"] .cc-atb-btn[data-cc-act="send"]`;
      for (const btn of document.querySelectorAll<HTMLButtonElement>(sel)) paintSend(btn);
    };

    // ---- the send popover (one shared instance under #cc-root) ---------------
    let sendUuid: string | null = null;
    let sendSelection = "";
    let currentScope: HandoffScope = "answer";
    let sending = false;

    const sendPop = ownedEl("div", {
      owner: OWNER,
      className: "cc-popover cc-send-pop cc-hidden",
      attrs: { id: "cc-atb-send-pop", role: "dialog", "aria-label": "Send to Claude Code" },
    });
    sendPop.append(
      ownedEl("div", { owner: OWNER, className: "cc-send-title", text: "Send to Claude Code" }),
    );
    const targetLine = ownedEl("div", { owner: OWNER, className: "cc-send-target" });
    sendPop.append(targetLine);
    sendPop.append(ownedEl("div", { owner: OWNER, className: "cc-send-sub", text: "What to send" }));
    const scopeSeg = ownedEl("div", {
      owner: OWNER,
      className: "cc-gear-seg cc-send-scope",
      attrs: { role: "radiogroup", "aria-label": "What to send" },
    });
    sendPop.append(scopeSeg);
    // No intent picker: what happens with the handoff is decided at PICKUP —
    // `/handoff <anything>` in Claude Code — so sending is a one-decision act.
    sendPop.append(
      ownedEl("div", {
        owner: OWNER,
        className: "cc-send-pickup",
        text: "Pick it up in Claude Code with /handoff — tell it there what to do.",
      }),
    );
    const statusLine = ownedEl("div", { owner: OWNER, className: "cc-send-status" });
    const actionRow = ownedEl("div", { owner: OWNER, className: "cc-send-actions" });
    const sendCancel = ownedEl("button", {
      owner: OWNER,
      className: "cc-btn cc-send-cancel",
      text: "Cancel",
      attrs: { type: "button" },
    });
    const sendGo = ownedEl("button", {
      owner: OWNER,
      className: "cc-btn cc-send-go",
      text: "Send",
      attrs: { type: "button" },
    });
    actionRow.append(sendCancel, sendGo);
    sendPop.append(statusLine, actionRow);
    ctx.root.appendChild(sendPop);
    ctx.onCleanup(() => sendPop.remove());

    const disambiguated = (s: BridgeSession): boolean =>
      bridgeSessions.filter((o) => o.project === s.project).length >= 2;

    /** The read-only target line mirroring the chip's binding (spec §4). */
    const refreshSendTarget = (): void => {
      const b = boundBridgeSession();
      if (!b) {
        targetLine.textContent = "";
        return;
      }
      const who = disambiguated(b) ? `${b.project} ·${b.shortId}` : b.project;
      targetLine.textContent = `→ ${who} (${b.path})`;
    };

    const renderScope = (): void => {
      scopeSeg.replaceChildren();
      const opts: Array<{ scope: HandoffScope; text: string }> = [
        { scope: "answer", text: "This answer" },
        { scope: "conversation", text: "Whole chat" },
      ];
      if (sendSelection) opts.push({ scope: "selection", text: "Selection" });
      if (!opts.some((o) => o.scope === currentScope)) currentScope = "answer";
      for (const o of opts) {
        const b = ownedEl("button", {
          owner: OWNER,
          className: "cc-gear-seg-btn",
          attrs: {
            type: "button",
            role: "radio",
            "aria-checked": o.scope === currentScope ? "true" : "false",
            "data-cc-scope": o.scope,
          },
        });
        b.append(ownedEl("span", { owner: OWNER, text: o.text }));
        scopeSeg.append(b);
      }
    };

    const closeSendPop = (): void => {
      sendPop.classList.add("cc-hidden");
      sending = false;
    };

    const openSendPopover = (uuid: string, anchor: HTMLButtonElement): void => {
      if (bridgeSessions.length === 0) return; // inert (spec §3)
      sendUuid = uuid;
      // Capture a text selection that lives inside THIS answer (selection scope).
      sendSelection = "";
      const answerEl = ctx.selectors.closest<HTMLElement>("assistantMessage", anchor);
      const selection = window.getSelection();
      if (
        answerEl &&
        selection &&
        selection.rangeCount > 0 &&
        !selection.isCollapsed &&
        selection.anchorNode &&
        answerEl.contains(selection.anchorNode)
      ) {
        sendSelection = selection.toString().trim();
      }
      currentScope = sendSelection ? "selection" : "answer";
      sending = false;
      statusLine.textContent = "";
      statusLine.classList.remove("cc-ok-text", "cc-danger-text");
      sendGo.removeAttribute("disabled");
      refreshSendTarget();
      renderScope();
      const r = anchor.getBoundingClientRect();
      setGeometry(sendPop, {
        top: Math.round(r.bottom + 6),
        left: Math.round(Math.min(r.left, window.innerWidth - 300)),
      });
      sendPop.classList.remove("cc-hidden");
    };

    const doSend = (): void => {
      if (sending || bridgeSessions.length === 0) return;
      sending = true;
      sendGo.setAttribute("disabled", "true");
      statusLine.classList.remove("cc-ok-text", "cc-danger-text");
      statusLine.textContent = "Sending…";
      ctx.bus.emit("bridge:send", {
        // Fixed neutral intent — the receiver chooses at pickup (/handoff).
        handle: "context",
        scope: currentScope,
        ...(sendUuid ? { uuid: sendUuid } : {}),
        ...(currentScope === "selection" ? { selectionText: sendSelection } : {}),
      });
    };

    ctx.listen(scopeSeg, "click", (ev: MouseEvent) => {
      const b = (ev.target instanceof Element ? ev.target : null)?.closest<HTMLElement>("[data-cc-scope]");
      const scope = b?.dataset["ccScope"] as HandoffScope | undefined;
      if (!scope) return;
      currentScope = scope;
      renderScope();
    });
    ctx.listen(sendGo, "click", (ev: MouseEvent) => {
      ev.stopPropagation();
      doSend();
    });
    ctx.listen(sendCancel, "click", (ev: MouseEvent) => {
      ev.stopPropagation();
      closeSendPop();
    });
    ctx.listen(document, "mousedown", (ev: MouseEvent) => {
      if (sendPop.classList.contains("cc-hidden")) return;
      const t = ev.target;
      if (t instanceof Element && (t.closest("#cc-atb-send-pop") || t.closest(".cc-atb-btn[data-cc-act='send']"))) {
        return;
      }
      closeSendPop();
    });
    ctx.listen(document, "keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !sendPop.classList.contains("cc-hidden")) closeSendPop();
    });

    ctx.on("bridge:changed", ({ sessions, boundSessionId }) => {
      bridgeSessions = sessions;
      bridgeBound = boundSessionId;
      repaintSends();
      if (!sendPop.classList.contains("cc-hidden")) {
        if (bridgeSessions.length === 0) closeSendPop();
        else refreshSendTarget();
      }
    });
    ctx.on("bridge:send-result", ({ ok, reason }) => {
      if (!sending) return;
      sending = false;
      sendGo.removeAttribute("disabled");
      statusLine.textContent = ok ? "Sent ✓" : reason ?? "nothing sent";
      statusLine.classList.toggle("cc-ok-text", ok);
      statusLine.classList.toggle("cc-danger-text", !ok);
      if (ok) ctx.setTimeout(() => closeSendPop(), 950);
    });

    // ---- click feedback flash (robust: supersede + derive + sweep) ------------
    let flashSeq = 0;

    /** Drop the flash markers and repaint the resting face. Safe on a
     *  disconnected node (it may be reattached by React later). */
    const clearFlash = (btn: HTMLButtonElement): void => {
      delete btn.dataset["ccFlash"];
      delete btn.dataset["ccFlashUntil"];
      btn.classList.remove("cc-atb-done", "cc-atb-fail");
      restingFace(btn);
    };

    /** Brief ✓ (or danger tint) on the pressed button, then ALWAYS back to
     *  the resting face. Re-armable: a new flash stamps a new generation, so
     *  any pending clear for the old one becomes a no-op. */
    const flash = (btn: HTMLButtonElement, ok: boolean): void => {
      const gen = String(++flashSeq); // supersedes any pending clear on btn
      btn.dataset["ccFlash"] = gen;
      btn.dataset["ccFlashUntil"] = String(Date.now() + FLASH_MS);
      btn.innerHTML = ICON_CHECK; // static, trusted markup
      btn.classList.remove("cc-atb-done", "cc-atb-fail");
      btn.classList.add(ok ? "cc-atb-done" : "cc-atb-fail");
      ctx.setTimeout(() => {
        if (btn.dataset["ccFlash"] !== gen) return; // superseded or cleared
        clearFlash(btn); // even if currently detached — see clearFlash
      }, FLASH_MS);
    };

    /** Sweep-time safety net: any button still wearing a flash past its
     *  deadline (clear timer lost to a remount/sweep edge) gets reset. */
    const clearExpiredFlashes = (): void => {
      const sel = `.cc-atb[data-cc-owner="${OWNER}"] .cc-atb-btn.cc-atb-done, .cc-atb[data-cc-owner="${OWNER}"] .cc-atb-btn.cc-atb-fail`;
      for (const btn of document.querySelectorAll<HTMLButtonElement>(sel)) {
        const until = Number(btn.dataset["ccFlashUntil"]);
        if (!Number.isFinite(until) || Date.now() >= until) clearFlash(btn);
      }
    };

    // ---- bar construction ------------------------------------------------------
    const buildBar = (): HTMLElement => {
      const bar = ownedEl("div", {
        owner: OWNER,
        className: "cc-atb",
        attrs: { role: "toolbar", "aria-label": "Answer tools" },
      });
      for (const a of ACTIONS) {
        const btn = ownedEl("button", {
          owner: OWNER,
          className: "cc-atb-btn",
          attrs: {
            type: "button",
            title: a.label,
            "aria-label": a.label,
            "data-cc-act": a.act,
          },
        });
        btn.innerHTML = a.icon; // static, trusted markup (bundled constants)
        bar.append(btn);
      }
      return bar;
    };

    const equip = (el: HTMLElement): void => {
      // Positioned ancestor + thread-only guard, via the core-owned slot API
      // (the slot itself stays empty; companion.css hides empty slots).
      const slot = ctx.decorations.gutterSlot(el, OWNER);
      if (!slot) return;
      if (el.querySelector(":scope > .cc-atb")) return;
      // uuid must resolve BEFORE we act on this answer — also keeps the bar
      // off still-streaming answers (not in the index yet). Quiet skip.
      const uuid = el.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(el);
      if (!uuid) return;
      const bar = buildBar();
      el.append(bar);
      // State faces — need the bar in the DOM (uuid lookup walks up).
      const pinBtn = bar.querySelector<HTMLButtonElement>('[data-cc-act="pin"]');
      if (pinBtn) paintPin(pinBtn);
      const popoutBtn = bar.querySelector<HTMLButtonElement>('[data-cc-act="popout"]');
      if (popoutBtn) paintPopout(popoutBtn);
      const sendBtn = bar.querySelector<HTMLButtonElement>('[data-cc-act="send"]');
      if (sendBtn) paintSend(sendBtn);
    };

    const removeAll = (): void => {
      for (const el of document.querySelectorAll(`.cc-atb[data-cc-owner="${OWNER}"]`)) {
        el.remove();
      }
    };

    // ---- actions -------------------------------------------------------------
    const messageText = (uuid: string): string | null => {
      const m = ctx.conversation.current()?.messages.find((msg) => msg.uuid === uuid);
      return m ? m.text : null;
    };

    const copyText = async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Clipboard API can be denied without document focus — legacy fallback.
        try {
          const ta = ownedEl("textarea", { owner: OWNER, className: "cc-atb-clip" });
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

    const run = (act: ToolbarAct, uuid: string, btn: HTMLButtonElement): void => {
      switch (act) {
        case "pin":
          // The pins feature toggles + persists, then broadcasts the new set
          // via "pins:changed" — which repaints this button's active face
          // (outline/export follow via storage + "conversation:updated").
          ctx.bus.emit("ui:pin-toggle", { uuid });
          flash(btn, true);
          break;
        case "copy": {
          const text = messageText(uuid);
          if (text === null) return;
          // Clean serialization (same serializer the export/note paths use),
          // flashed only after the clipboard write actually resolves.
          void copyText(cleanExportBody(text)).then((ok) => {
            if (ctx.signal.aborted) return;
            flash(btn, ok);
          });
          break;
        }
        case "popout":
          // TOGGLE: the mini-window feature adds/removes THIS answer's card
          // in the always-on-top window; the active face repaints off its
          // "mini-window:changed" broadcast (no flash — state is the signal).
          ctx.bus.emit("ui:mini-window-popout", { uuid });
          break;
        case "note": {
          const text = messageText(uuid);
          if (text === null) return;
          // The notes feature files it as a new note for this conversation.
          ctx.bus.emit("ui:note-append", { text: snippetOf(text, NOTE_SNIPPET_MAX) });
          flash(btn, true);
          break;
        }
        case "send":
          // Inert until a Claude Code session connects (spec §3). Otherwise
          // open the handle/scope popover; the claude-code-bridge feature does
          // the assembly + push (features never import each other).
          if (bridgeSessions.length === 0) return;
          openSendPopover(uuid, btn);
          break;
      }
    };

    // Delegated clicks — survive virtualization re-renders untouched (pins
    // pattern). Native buttons make Enter/Space work for keyboard users.
    ctx.listen(document, "click", (ev: MouseEvent) => {
      const target = ev.target instanceof Element ? ev.target : null;
      const btn = target?.closest<HTMLButtonElement>(".cc-atb-btn");
      if (!btn || !btn.closest(`[data-cc-owner="${OWNER}"]`)) return;
      const el = ctx.selectors.closest<HTMLElement>("assistantMessage", btn);
      if (!el) return;
      ev.stopPropagation();
      const uuid = el.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(el);
      if (!uuid) return; // index not ready — quietly do nothing
      const act = btn.dataset["ccAct"] as ToolbarAct | undefined;
      if (act) run(act, uuid, btn);
    });

    // ---- maintenance sweep (pins pattern) -------------------------------------
    const sweep = (): void => {
      for (const el of answers()) equip(el);
      clearExpiredFlashes();
    };
    ctx.setInterval(sweep, SWEEP_MS);
    ctx.on("conversation:updated", sweep);
    sweep();

    // Runtime disposal also removes every [data-cc-owner="answer-toolbar"]
    // node as a safety net; this keeps teardown explicit.
    ctx.onCleanup(removeAll);
  },
};
