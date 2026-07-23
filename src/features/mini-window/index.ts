/**
 * Mini-window — Tier 2, SESSION scope (the pinned window must survive
 * conversation switches; it dies only with the tab).
 *
 * THE MODEL (original design, restored 2026-07-22 after a rebuild replaced
 * it with big `window.open` popups): the answer toolbar's pop-out action
 * TOGGLES that answer's card in the single Document Picture-in-Picture
 * window — the web's only true always-on-top surface. The PiP window is
 * compact, has no browser chrome beyond the slim native strip, and stays
 * visible over every tab and OS window until closed. Multiple answers stack
 * as cards in its scrollable column (the platform allows exactly one PiP
 * window). On Firefox (no Document PiP, 2026) each answer degrades to its
 * own small popup window — same toggle contract, just not always-on-top.
 *
 * Entry points (bus `ui:mini-window-popout` — synchronous from the click,
 * which carries the user gesture requestWindow consumes):
 * - Answer toolbar: uuid → toggle exactly that answer's card. The toolbar
 *   button paints active while the card is up (via "mini-window:changed"),
 *   so a lost window is always recoverable from the message itself.
 * - Command palette: no uuid → toggle the answer nearest the viewport
 *   center.
 *
 * Standards honored:
 * - Content comes from the API index (ctx.conversation + cleanExportBody),
 *   never scraped from claude's DOM; titles via shared firstLabelOf; the
 *   card markup (card.ts) + markdown renderer (markdown.ts) are built in the
 *   page document and ADOPTED into the spawned window's document.
 * - Own-UI-only: every spawned document is entirely ours. Styling inside is
 *   companion.css + a --cc-* token snapshot (./os-window.ts) — tokens only.
 * - State fan-out mirrors pins: "mini-window:changed" carries the FULL uuid
 *   set on every change and re-broadcasts on "conversation:indexed" so the
 *   conversation-scoped toolbar can cold-start after a chat switch.
 * - Managed ctx resources exclusively; unmount closes every spawned window
 *   (the PiP and any fallback popups) — their documents die with them.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { cleanExportBody, clip } from "@/shared/text";
import { firstLabelOf } from "@/shared/message-outline";
import { buildCard, type CardRefs } from "./card";
import { renderMarkdown } from "./markdown";
import {
  openFallbackWindow,
  pipSupported,
  prepareWindowDocument,
  requestPipWindow,
} from "./os-window";

const OWNER = "mini-window";

/** Compact by design — the window holds one answer's distilled card, not a
 *  browser page. The OS/native strip remembers user resizes while it lives. */
const PIP_W = 360;
const PIP_H = 460;
/**
 * The PiP window's title — a STABLE PUBLIC CONTRACT, never reword casually:
 * on Wayland no client can enforce always-on-top (only the compositor can),
 * so users pin the window with a compositor rule matching THIS exact title
 * (KWin window rule / Hyprland windowrule; documented in the README).
 * Renaming it silently breaks those rules.
 */
const PIP_WINDOW_TITLE = "Clenby — pinned answers";
/** Firefox fallback popups (one per answer). */
const WIN_W = 340;
const WIN_H = 460;
const CASCADE_PX = 28;
const CASCADE_SLOTS = 8;
const TITLE_MAX = 70;
/** Belt-and-braces sweep for windows whose pagehide got lost. */
const PRUNE_MS = 2500;

/** Realm-safe Element check — nodes in spawned documents are from another
 *  realm, so `instanceof Element` can't be trusted there. */
const asElement = (t: EventTarget | null): Element | null =>
  t !== null && typeof (t as Element).closest === "function" ? (t as Element) : null;

export const miniWindow: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "session",

  mount(ctx: FeatureContext) {
    // Make sure the API index (content + uuid source) is being built.
    void ctx.conversation.ensure();

    const pipOk = pipSupported();
    if (!pipOk) {
      // Diagnosable, once: makes "why is my pop-out a plain window?" a
      // console glance instead of a guessing game (Firefox, or a Chromium
      // build/world without Document PiP).
      console.info("[cc] Document PiP unavailable — mini-window uses popup windows");
    }

    /** Chrome path: THE PiP window + its card column + one card per uuid. */
    let pip: { win: Window; host: HTMLElement } | null = null;
    const pipCards = new Map<string, CardRefs>();
    /** requestWindow in flight — ignore further toggles until it settles. */
    let opening = false;

    /** Firefox path: one fallback popup per uuid. */
    const fallbackWins = new Map<string, Window>();
    let spawnSeq = 0;

    const currentUuids = (): string[] => [...pipCards.keys(), ...fallbackWins.keys()];

    const emitChanged = (): void => {
      ctx.bus.emit("mini-window:changed", { uuids: currentUuids() });
    };

    // ---- shared card bits ---------------------------------------------------
    /** Tickable checklist rows — works in every spawned window's document. */
    const toggleCheckFromEvent = (ev: Event): boolean => {
      const row = asElement(ev.target)?.closest<HTMLElement>(".cc-mw-check");
      if (!row) return false;
      const done = row.classList.toggle("cc-done");
      row.setAttribute("aria-checked", done ? "true" : "false");
      return true;
    };

    const buildAnswerCard = (uuid: string, text: string): { refs: CardRefs; title: string } => {
      const title = clip(firstLabelOf(text), TITLE_MAX);
      const refs = buildCard(OWNER, title);
      refs.el.dataset["ccUuid"] = uuid; // the delegated handlers' key
      refs.body.append(renderMarkdown(OWNER, cleanExportBody(text)));
      // Console strip counts — derived from the rendered content ("3 steps ·
      // 2 todos"); empty when the answer has neither (CSS hides the slot).
      const steps = refs.body.querySelectorAll("ol.cc-mw-steps > li").length;
      const todos = refs.body.querySelectorAll(".cc-mw-check").length;
      refs.counts.textContent = [
        steps > 0 ? `${steps} step${steps === 1 ? "" : "s"}` : "",
        todos > 0 ? `${todos} todo${todos === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return { refs, title };
    };

    /** Delegated interactions inside a spawned window (the PiP or a fallback
     *  popup). All listeners are ctx-managed — removed at unmount, inert once
     *  the window's document is destroyed by close(). */
    const wireWindow = (w: Window): void => {
      ctx.listen(w.document, "click", (ev: Event) => {
        if (toggleCheckFromEvent(ev)) return;
        const t = asElement(ev.target);
        const btn = t?.closest<HTMLElement>(".cc-mw-btn");
        if (!btn) return;
        const uuid = btn.closest<HTMLElement>(".cc-mw")?.dataset["ccUuid"];
        if (!uuid) return;
        switch (btn.dataset["ccAct"]) {
          case "jump":
            ctx.matcher.jumpTo(uuid); // the real seek, same as outline/atlas
            window.focus(); // surface the claude.ai tab under the pinned window
            break;
          case "close":
            remove(uuid);
            break;
        }
      });
      ctx.listen(w, "keydown", (ev: Event) => {
        const ke = ev as KeyboardEvent;
        if (ke.key === "Escape") {
          // Esc closes the whole window (the PiP's native ✕ equivalent; a
          // fallback popup holds one answer anyway).
          w.close();
          return;
        }
        if (ke.key === " " || ke.key === "Enter") {
          const t = asElement(ke.target);
          if (t?.classList.contains("cc-mw-check")) {
            ke.preventDefault();
            toggleCheckFromEvent(ev);
          }
        }
      });
    };

    // ---- PiP lifecycle --------------------------------------------------------
    /** The PiP window closed (native ✕, Esc, another site's PiP evicted ours,
     *  opener tab dying) — every card died with its document. */
    const onPipGone = (win: Window): void => {
      if (pip?.win !== win) return;
      pip = null;
      pipCards.clear();
      emitChanged();
    };

    const addPipCard = (uuid: string, text: string): void => {
      if (!pip || pip.win.closed) return;
      const { refs } = buildAnswerCard(uuid, text);
      pip.host.appendChild(pip.win.document.adoptNode(refs.el));
      pipCards.set(uuid, refs);
      emitChanged();
    };

    /** Open THE PiP window. Reached synchronously from the click — the
     *  requestWindow call inside rides that gesture. */
    const openPipWith = (uuid: string, text: string): void => {
      if (opening) return;
      opening = true;
      void requestPipWindow(PIP_W, PIP_H).then((win) => {
        opening = false;
        if (!win) return; // denied — quietly do nothing
        if (ctx.signal.aborted) {
          win.close();
          return;
        }
        const host = prepareWindowDocument(win, PIP_WINDOW_TITLE, "pip");
        // A fresh window always starts empty: if the previous PiP died with a
        // lost pagehide (OS-level close) inside the prune window, stale
        // entries would otherwise ride along as phantom active buttons.
        pipCards.clear();
        pip = { win, host };
        wireWindow(win);
        ctx.listen(win, "pagehide", () => onPipGone(win));
        addPipCard(uuid, text);
      });
    };

    // ---- fallback (Firefox) lifecycle ------------------------------------------
    const onFallbackGone = (uuid: string, win: Window): void => {
      if (fallbackWins.get(uuid) !== win) return;
      fallbackWins.delete(uuid);
      emitChanged();
    };

    /** One popup per answer. Also synchronous from the click. */
    const openFallbackWith = (uuid: string, text: string): void => {
      const cascade = (spawnSeq++ % CASCADE_SLOTS) * CASCADE_PX;
      const win = openFallbackWindow(WIN_W, WIN_H, cascade);
      if (!win) return; // popup blocked — quietly do nothing
      const { refs, title } = buildAnswerCard(uuid, text);
      const host = prepareWindowDocument(win, title, "win");
      host.appendChild(win.document.adoptNode(refs.el));
      fallbackWins.set(uuid, win);
      wireWindow(win);
      ctx.listen(win, "pagehide", () => onFallbackGone(uuid, win));
      emitChanged();
    };

    // ---- the toggle --------------------------------------------------------------
    const remove = (uuid: string): void => {
      const card = pipCards.get(uuid);
      if (card) {
        pipCards.delete(uuid);
        card.el.remove();
        emitChanged();
        // The last card leaving closes the window — an empty always-on-top
        // shell is just clutter (closing fires pagehide → onPipGone, which
        // finds the map already empty).
        if (pip && pipCards.size === 0) pip.win.close();
        return;
      }
      const win = fallbackWins.get(uuid);
      if (win) {
        win.close(); // pagehide → onFallbackGone drops the entry
        // Belt: some closes report no pagehide synchronously — reflect now.
        onFallbackGone(uuid, win);
      }
    };

    const toggle = (uuid: string): void => {
      if (pipCards.has(uuid) || fallbackWins.has(uuid)) {
        remove(uuid);
        return;
      }
      const message = ctx.conversation.current()?.messages.find((m) => m.uuid === uuid);
      if (!message) return; // index not ready — quietly do nothing
      if (pipOk) {
        if (pip && !pip.win.closed) addPipCard(uuid, message.text);
        else openPipWith(uuid, message.text);
      } else {
        openFallbackWith(uuid, message.text);
      }
    };

    // ---- lifecycle safety nets ---------------------------------------------------
    // pagehide covers every close path in practice; this sweep is the belt for
    // any OS-level close whose event got lost.
    ctx.setInterval(() => {
      if (pip && pip.win.closed) onPipGone(pip.win);
      for (const [uuid, win] of [...fallbackWins]) {
        if (win.closed) onFallbackGone(uuid, win);
      }
    }, PRUNE_MS);

    ctx.onCleanup(() => {
      pip?.win.close(); // the PiP document — cards included — dies with it
      pip = null;
      pipCards.clear();
      for (const win of fallbackWins.values()) win.close();
      fallbackWins.clear();
    });

    // Conversation-scoped consumers (the answer toolbar) remount on every
    // chat switch and miss broadcasts from before their mount — re-emit when
    // an index lands so their pop-out buttons cold-start correctly. Also on
    // conversation:updated: a fast cached index can resolve BEFORE the
    // toolbar's remount finishes subscribing, and updated fires often enough
    // (pins, notes, generation ends) to converge that window too.
    ctx.on("conversation:indexed", () => emitChanged());
    ctx.on("conversation:updated", () => emitChanged());

    // ---- palette entry point: toggle the answer nearest the viewport center
    // (bus event — features never import each other).
    const answers = (): HTMLElement[] =>
      ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);

    const nearestAnswer = (): HTMLElement | null => {
      const vh = window.innerHeight;
      let best: HTMLElement | null = null;
      let bestScore = Infinity;
      for (const el of answers()) {
        const r = el.getBoundingClientRect();
        if (r.height === 0) continue;
        const d = Math.abs(r.top + r.height / 2 - vh / 2);
        const visible = r.bottom > 0 && r.top < vh;
        const score = visible ? d : d + 100000; // off-screen only as last resort
        if (score < bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return best;
    };

    ctx.on("ui:mini-window-popout", ({ uuid }) => {
      // The answer-toolbar names the exact answer; the palette sends no uuid
      // → act on the answer nearest the viewport center.
      if (uuid) {
        toggle(uuid);
        return;
      }
      const el = nearestAnswer();
      if (!el) return;
      const id = el.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(el);
      if (id) toggle(id); // index not ready — quietly do nothing
    });
  },
};
