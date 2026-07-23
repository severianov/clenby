/**
 * Regen safety net — Output repair. Conversation scope.
 *
 * Before a retry/regenerate reroll replaces an answer, snapshot that answer's
 * API text locally so a worse reroll can't lose the good one. Memory-only for
 * v1 (session-lived, per conversation — the runtime remount on conversation
 * switch clears it by construction); the last few snapshots are kept.
 *
 * Capture: a capture-phase click on claude's retry control — the selector
 * from core/selectors.ts, plus a documented label heuristic for the retry
 * options that live in a dropdown menu (portal-rendered [role="menuitem"]s
 * carry no stable selector; same local-heuristic precedent as undo-send's
 * send/voice lookups). The click is only OBSERVED — never prevented, retried
 * or re-fired (fail open). The snapshot text comes from the
 * conversation index (API text, export-grade), never scraped from the DOM.
 * When the clicked control can't be tied to a specific rendered answer (menu
 * items), the LAST assistant message is snapshotted — retry acts on the last
 * answer on claude.ai.
 *
 * Expose: once the reroll's generation ends and the store refetches
 * (`conversation:updated`), the snapshot is bound to the NEW last answer
 * (rerolls mint a new uuid — the old one leaves the rendered branch) and a
 * small "previous answer saved" affordance attaches to it (pins attach
 * pattern; label via ::before content:attr() → zero innerText added; only
 * attached after the answer's uuid is cached). Clicking opens an own-UI panel
 * under #cc-root: snapshot picker (newest first), read-only body, copy.
 *
 * Toggle: settings.regenSafetyNetOn (gear "Repair" row + palette), reacted
 * to via storage.onSettingsChanged — no feature imports.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl } from "@/ui/root";

const OWNER = "regen-safety-net";

const SWEEP_MS = 900;
const MAX_SNAPSHOTS = 5;
const FLASH_MS = 1400;
/** A retry click with no generation start within this window is considered
 *  abandoned (menu dismissed, request failed). */
const PENDING_RETRY_TTL_MS = 60_000;

/** Menu-item retry labels (dropdown "Retry" / "Retry with <model>" — see
 *  header note on why this is a local heuristic). */
const RETRY_TEXT_RE = /^(retry|regenerate)\b/i;
const RETRY_TEXT_MAX = 48;

/** lucide "history" — matches claude's icon style (stroke: currentColor). */
const ICON_HISTORY =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>';
const ICON_COPY =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_X =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

interface Snapshot {
  /** uuid of the ORIGINAL (pre-regen) message. */
  uuid: string;
  /** API text at capture time. */
  text: string;
  /** Capture time (epoch ms). */
  at: number;
  /** uuid of the rerolled answer the affordance attaches to (null until the
   *  reroll lands). */
  exposedOn: string | null;
}

export const regenSafetyNet: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "conversation",

  async mount(ctx: FeatureContext) {
    let on = true;
    /** Newest first. Memory-only (v1) — cleared with the conversation remount. */
    const snapshots: Snapshot[] = [];
    let pendingRetryAt: number | null = null;
    let retryGenSeen = false;
    let panelSelected = 0;
    let flashGen = 0;

    // Make sure the API index (uuid + text source) is being built.
    void ctx.conversation.ensure();

    // ---- capture --------------------------------------------------------------
    const isRetryControl = (start: Element): boolean => {
      if (ctx.selectors.closest("retryButton", start)) return true;
      const item = start.closest<HTMLElement>('[role="menuitem"],[role="option"]');
      if (!item) return false;
      const label = (item.getAttribute("aria-label") ?? item.textContent ?? "").trim();
      return label.length <= RETRY_TEXT_MAX && RETRY_TEXT_RE.test(label);
    };

    const takeSnapshot = (start: Element): void => {
      const index = ctx.conversation.current();
      if (!index) return; // no index yet — nothing trustworthy to save

      // Tie the control to its rendered answer where possible…
      let uuid: string | null = null;
      const block = ctx.selectors.closest("messageBlock", start);
      if (block) {
        const answerEl = ctx.selectors.query<HTMLElement>("assistantMessage", block);
        if (answerEl) {
          uuid = answerEl.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(answerEl);
        }
      }
      // …otherwise (dropdown menu items render in a portal) fall back to the
      // last assistant message — retry acts on the last answer.
      const msg = uuid
        ? index.messages.find((m) => m.uuid === uuid && m.sender === "assistant")
        : [...index.messages].reverse().find((m) => m.sender === "assistant");
      if (!msg || !msg.text.trim()) return;

      // Dedupe: re-clicking retry (or opening the model menu after the
      // button) must not double-save the same answer.
      if (snapshots[0]?.uuid === msg.uuid && snapshots[0]?.text === msg.text) {
        pendingRetryAt = Date.now();
        retryGenSeen = false;
        return;
      }
      snapshots.unshift({ uuid: msg.uuid, text: msg.text, at: Date.now(), exposedOn: null });
      snapshots.length = Math.min(snapshots.length, MAX_SNAPSHOTS);
      pendingRetryAt = Date.now();
      retryGenSeen = false;
    };

    // Observe-only capture click (never prevented — fail open).
    ctx.listen(
      document,
      "click",
      (ev: MouseEvent) => {
        if (!on) return;
        const t = ev.target instanceof Element ? ev.target : null;
        if (!t || t.closest("#cc-root")) return;
        if (!isRetryControl(t)) return;
        takeSnapshot(t);
      },
      { capture: true },
    );

    // ---- expose after the reroll lands ------------------------------------------
    ctx.on("generation:start", () => {
      if (pendingRetryAt !== null) retryGenSeen = true;
    });

    ctx.on("conversation:updated", () => {
      if (pendingRetryAt === null) return;
      if (Date.now() - pendingRetryAt > PENDING_RETRY_TTL_MS) {
        pendingRetryAt = null; // abandoned retry — never expose
        retryGenSeen = false;
        return;
      }
      // conversation:updated also fires for non-regen reasons (pins persist,
      // etc.) — require a generation cycle since the retry click.
      if (!retryGenSeen) return;
      const index = ctx.conversation.current();
      const last = [...(index?.messages ?? [])].reverse().find((m) => m.sender === "assistant");
      const snap = snapshots[0];
      if (!index || !last || !snap) return;
      // Bind to the rerolled answer. On a same-uuid refresh (rare) the
      // affordance still shows — the user explicitly asked for a reroll.
      snap.exposedOn = last.uuid;
      pendingRetryAt = null;
      retryGenSeen = false;
    });

    // ---- affordance chip (pins attach pattern; zero innerText) ------------------
    const removeChips = (): void => {
      for (const el of document.querySelectorAll(`.cc-rsn-chip[data-cc-owner="${OWNER}"]`)) {
        el.remove();
      }
    };

    const equip = (): void => {
      if (!on) return;
      const exposed = snapshots.filter((s) => s.exposedOn !== null);
      if (exposed.length === 0) return;
      const answers = ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);
      for (const el of answers) {
        // uuid must resolve+cache BEFORE we attach (dom-matcher hygiene).
        const uuid = el.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(el);
        if (!uuid) continue;
        const has = el.querySelector<HTMLElement>(":scope > .cc-rsn-chip");
        const wants = exposed.some((s) => s.exposedOn === uuid);
        const n = exposed.filter((s) => s.exposedOn === uuid).length;
        const label = n > 1 ? `${n} previous answers saved` : "previous answer saved";
        if (wants && !has) {
          const btn = ownedEl("button", {
            owner: OWNER,
            className: "cc-rsn-chip",
            attrs: {
              type: "button",
              "data-cc-label": label,
              title: "View or copy the answer this reroll replaced",
              "aria-label": "View or copy the previous version of this answer",
            },
          });
          btn.innerHTML = ICON_HISTORY; // static, trusted markup
          el.append(btn);
        } else if (wants && has) {
          // Keep the count fresh after a second reroll of the same answer.
          if (has.getAttribute("data-cc-label") !== label) {
            has.setAttribute("data-cc-label", label);
          }
        } else if (!wants && has) {
          has.remove();
        }
      }
    };

    // ---- viewer panel (own-UI, top-level under #cc-root) -----------------
    const scrim = ownedEl("div", { owner: OWNER, className: "cc-rsn-scrim cc-hidden" });
    const panel = ownedEl("div", {
      owner: OWNER,
      className: "cc-rsn-panel cc-hidden",
      attrs: { role: "dialog", "aria-label": "Previous answers saved before retry" },
    });
    ctx.root.append(scrim, panel);
    ctx.onCleanup(() => {
      scrim.remove();
      panel.remove();
    });

    const closePanel = (): void => {
      scrim.classList.add("cc-hidden");
      panel.classList.add("cc-hidden");
    };

    const copyText = async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const ta = ownedEl("textarea", { owner: OWNER, className: "cc-rsn-clip" });
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

    const timeLabel = (at: number): string =>
      new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    /** The snapshots the open panel is showing (rebuilt on every render;
     *  clicks are DELEGATED on the panel so re-renders never stack listeners). */
    let panelList: Snapshot[] = [];
    let panelFor: string | null = null;

    const renderPanel = (): void => {
      panel.replaceChildren();
      const rows = panelFor
        ? snapshots.filter((s) => s.exposedOn === panelFor)
        : snapshots.filter((s) => s.exposedOn !== null);
      panelList = rows.length > 0 ? rows : [...snapshots];
      panelSelected = Math.min(panelSelected, Math.max(0, panelList.length - 1));
      const current = panelList[panelSelected];

      const head = ownedEl("div", { owner: OWNER, className: "cc-rsn-head" });
      head.append(
        ownedEl("span", {
          owner: OWNER,
          className: "cc-rsn-title",
          text: "Previous answer — saved before retry",
        }),
      );
      const copyBtn = ownedEl("button", {
        owner: OWNER,
        className: "cc-rsn-copy",
        attrs: { type: "button", title: "Copy this saved answer", "aria-label": "Copy this saved answer" },
      });
      copyBtn.innerHTML = ICON_COPY; // static, trusted markup
      copyBtn.append(ownedEl("span", { owner: OWNER, text: "Copy" }));
      const closeBtn = ownedEl("button", {
        owner: OWNER,
        className: "cc-rsn-close",
        attrs: { type: "button", title: "Close (Esc)", "aria-label": "Close" },
      });
      closeBtn.innerHTML = ICON_X; // static, trusted markup
      head.append(copyBtn, closeBtn);
      panel.append(head);

      if (panelList.length > 1) {
        const tabs = ownedEl("div", { owner: OWNER, className: "cc-rsn-tabs" });
        panelList.forEach((s, i) => {
          tabs.append(
            ownedEl("button", {
              owner: OWNER,
              className: "cc-rsn-tab",
              text: `${timeLabel(s.at)} · ${s.text.length.toLocaleString()} chars`,
              attrs: {
                type: "button",
                "data-cc-tab": String(i),
                "aria-pressed": i === panelSelected ? "true" : "false",
              },
            }),
          );
        });
        panel.append(tabs);
      }

      const body = ownedEl("div", { owner: OWNER, className: "cc-rsn-body" });
      // Read-only view of the saved markdown SOURCE — textContent only.
      body.textContent = current
        ? current.text
        : "Nothing saved yet — snapshots are taken when you press Retry.";
      panel.append(body);

      if (current) {
        panel.append(
          ownedEl("div", {
            owner: OWNER,
            className: "cc-rsn-foot",
            text: `Saved ${timeLabel(current.at)} · kept for this tab only (last ${MAX_SNAPSHOTS} rerolls)`,
          }),
        );
      }
    };

    // One delegated listener drives every panel control.
    ctx.listen(panel, "click", (ev: MouseEvent) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (!t) return;
      if (t.closest(".cc-rsn-close")) {
        closePanel();
        return;
      }
      const tab = t.closest<HTMLElement>(".cc-rsn-tab");
      if (tab) {
        const i = Number.parseInt(tab.getAttribute("data-cc-tab") ?? "", 10);
        if (Number.isInteger(i) && i >= 0 && i < panelList.length) {
          panelSelected = i;
          renderPanel();
        }
        return;
      }
      const copyBtn = t.closest<HTMLButtonElement>(".cc-rsn-copy");
      if (copyBtn) {
        const current = panelList[panelSelected];
        if (!current) return;
        void copyText(current.text).then((ok) => {
          if (ctx.signal.aborted || !copyBtn.isConnected) return;
          const svg = copyBtn.querySelector("svg");
          if (!svg) return;
          const prev = svg.outerHTML;
          svg.outerHTML = ICON_CHECK; // static, trusted markup
          copyBtn.classList.add(ok ? "cc-rsn-done" : "cc-rsn-fail");
          const gen = String(++flashGen);
          copyBtn.dataset["ccFlash"] = gen;
          ctx.setTimeout(() => {
            if (copyBtn.dataset["ccFlash"] !== gen || !copyBtn.isConnected) return;
            copyBtn.querySelector("svg")?.remove();
            copyBtn.insertAdjacentHTML("afterbegin", prev); // our own trusted SVG
            copyBtn.classList.remove("cc-rsn-done", "cc-rsn-fail");
          }, FLASH_MS);
        });
      }
    });

    const openPanel = (forUuid: string | null): void => {
      panelSelected = 0;
      panelFor = forUuid;
      renderPanel();
      scrim.classList.remove("cc-hidden");
      panel.classList.remove("cc-hidden");
    };

    // Chip clicks — delegated (survive virtualization re-renders).
    ctx.listen(document, "click", (ev: MouseEvent) => {
      const t = ev.target instanceof Element ? ev.target : null;
      const chip = t?.closest<HTMLButtonElement>(`.cc-rsn-chip[data-cc-owner="${OWNER}"]`);
      if (!chip) return;
      ev.stopPropagation();
      const el = ctx.selectors.closest<HTMLElement>("assistantMessage", chip);
      openPanel(el?.dataset["ccUuid"] ?? null);
    });
    ctx.listen(scrim, "mousedown", closePanel);
    ctx.listen(
      document,
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || panel.classList.contains("cc-hidden")) return;
        ev.preventDefault();
        ev.stopPropagation();
        closePanel();
      },
      { capture: true },
    );

    // ---- settings toggle (gear "Repair" row / palette — no feature imports) ---
    const settings = await ctx.storage.getSettings();
    if (ctx.signal.aborted) return;
    on = settings.regenSafetyNetOn;

    ctx.onCleanup(
      ctx.storage.onSettingsChanged((s) => {
        if (s.regenSafetyNetOn === on) return;
        on = s.regenSafetyNetOn;
        if (!on) {
          removeChips();
          closePanel();
        }
      }),
    );

    // ---- maintenance sweep (pins pattern) --------------------------------------
    ctx.setInterval(equip, SWEEP_MS);
    equip();

    // Runtime disposal also sweeps every [data-cc-owner="regen-safety-net"]
    // node; this keeps teardown explicit.
    ctx.onCleanup(removeChips);
  },
};
