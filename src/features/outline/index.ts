/**
 * Outline navigator — Tier 1, conversation scope.
 *
 * Questions / Answers / Marks tabs + scoped per-tab search (below the tabs,
 * placeholder follows the active tab) + jump-to-message.
 *
 * STRUCTURE:
 * - Tab / search / pinned-group / heading rendering with scoped search.
 * - Marks rows with ✕; export toolbar (count + icon buttons). The Answers
 *   tab reuses the same toolbar (identical markup/classes) above the 📌
 *   Pinned group to copy/download the pinned answers as Markdown.
 * - Panel chrome + drag: ./panel.ts.
 *
 * LANDMINES:
 * - Index from the API via ctx.conversation — NEVER the DOM (virtualization
 *   keeps only 2–4 messages rendered). DOM-fallback indexes get a subtle
 *   "partial index" hint (degradation rule).
 * - Jump goes through ctx.matcher.jumpTo (direct match →
 *   proportional scroll → ≤16×300 ms retries).
 * - Outline labels: skip lines that markdown-strip to nothing and artifact
 *   placeholders ("This block is not supported…"); fallback label
 *   "📄 (artifact / code block)".
 * - Answers numbered symmetrically with Questions; remaining headings
 *   indented beneath (8 + (lvl−1)·9 px, via data-lvl CSS).
 * - Pins/highlights are read from ctx.storage.conv ("pins" / "highlights") —
 *   decoupled from the pins/highlights features (features never import
 *   features); a poll picks up their writes.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import type { ConversationIndex, IndexedMessage } from "@/core/conversation-store";
import type { HighlightRecord } from "@/core/storage";
import { cleanExportBody, clip, normalizeWhitespace } from "@/shared/text";
import { firstLabelOf, headingsOf } from "@/shared/message-outline";
import { DEFAULT_POS, buildPanel, clampPos, wireDrag, type TabId } from "./panel";
import { ownedEl, setGeometry } from "@/ui/root";

const OWNER = "outline";
const SEARCH_MIN = 2;
const STORE_POLL_MS = 1200;
const MARK_JUMP_RETRY_MS = 1200;
const FLASH_RESTORE_MS = 1600;
/** How long the shared cc-sent-pulse success animation class stays applied — a
 *  touch past its 250ms CSS animation, then cleared by a managed timer. */
const PULSE_MS = 320;

/** Shown on the export-toolbar send buttons while no Claude Code session is
 *  connected — the send is inert until ≥1 session lights it up (spec §3). */
const SEND_INERT_LABEL = "Start Claude Code and this lights up.";

const PLACEHOLDER: Record<TabId, string> = {
  q: "Search your questions…",
  a: "Search Claude’s answers…",
  h: "Search highlights…",
};

// Static lucide-style line icons for the Marks export toolbar. Constants only — never interpolated with data.
const SVG_COPY =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const SVG_DL =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
const SVG_OK =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
/** Same paper-plane the answer-toolbar uses for "Send to Claude Code". */
const SVG_SEND =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>';

// Heading/label extraction lives in @/shared/message-outline — shared with
// the Conversation Atlas, which maps the same questions + answer headings.

const lower = (t: string): string => normalizeWhitespace(t).toLowerCase();

export const outline: FeatureModule = {
  id: OWNER,
  tier: 1,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    const refs = buildPanel(OWNER);
    ctx.root.appendChild(refs.panel);
    ctx.onCleanup(() => refs.panel.remove());
    setGeometry(refs.panel, DEFAULT_POS);

    // ---- state ----
    let activeTab: TabId = "a";
    let pins: string[] = [];
    let highlights: HighlightRecord[] = [];
    // ≥1 Claude Code session connected (bus-fed) — the export toolbars' send
    // buttons are inert until this flips true (spec §3).
    let bridgeLive = false;
    const actions = new Map<string, () => void>();
    let actionSeq = 0;

    const act = (fn: () => void): string => {
      const id = String(actionSeq++);
      actions.set(id, fn);
      return id;
    };

    // ---- position: restore persisted panelPos (clamped), persist on drop ----
    void ctx.storage.getSettings().then((s) => {
      if (ctx.signal.aborted) return;
      if (s.panelPos) setGeometry(refs.panel, clampPos(s.panelPos.left, s.panelPos.top, refs.panel));
    });
    wireDrag(ctx, refs, (pos) => {
      void ctx.storage.setSetting("panelPos", pos);
    });

    // ---- small builders (DOM-safe — API/user text only ever via textContent) ----

    const addGroup = (label: string): void => {
      refs.list.append(ownedEl("div", { owner: OWNER, className: "cc-group", text: label }));
    };

    const addHint = (text: string): void => {
      refs.list.append(ownedEl("div", { owner: OWNER, className: "cc-hits", text }));
    };

    const makeItem = (opts: { gold?: boolean; sub?: boolean; lvl?: number }): HTMLDivElement => {
      const it = ownedEl("div", {
        owner: OWNER,
        className:
          "cc-item" + (opts.gold ? " cc-item-gold" : "") + (opts.sub ? " cc-item-sub" : ""),
      });
      if (opts.sub) it.dataset["lvl"] = String(Math.min(3, Math.max(1, opts.lvl ?? 1)));
      return it;
    };

    const numSpan = (n: number, bold: boolean): HTMLSpanElement =>
      ownedEl("span", { owner: OWNER, className: bold ? "cc-num" : "cc-faint", text: String(n) });

    /** Numbered "n · label" row (Questions + Answers numbering symmetry). */
    const addNumbered = (
      n: number,
      label: string,
      onClick: () => void,
      opts: { gold?: boolean; pinMarker?: boolean; bold?: boolean } = {},
    ): void => {
      const it = makeItem({ gold: opts.gold ?? false });
      if (opts.pinMarker) it.append("📌 ");
      it.append(numSpan(n, opts.bold ?? false), ` · ${label}`);
      it.dataset["ccAct"] = act(onClick);
      refs.list.append(it);
    };

    const jumpMsg = (m: IndexedMessage, headingText?: string): void => {
      ctx.matcher.jumpTo(m.uuid, headingText ? { headingText } : {});
    };

    // ---- highlights (Marks) helpers ----

    const markEl = (id: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(`mark.cc-hl[data-hl-id="${CSS.escape(id)}"]`);

    const flashMark = (mk: HTMLElement): void => {
      mk.scrollIntoView({ behavior: "smooth", block: "center" });
      mk.classList.remove("cc-flash");
      void mk.offsetWidth; // restart the animation
      mk.classList.add("cc-flash");
    };

    const jumpHl = (h: HighlightRecord): void => {
      const mk = markEl(h.id);
      if (mk) {
        flashMark(mk);
        return;
      }
      // Not rendered — seek to the owning message, then retry the mark once
      // the highlights feature has re-applied it in the rendered neighborhood.
      // uuid can be null on wrap-first records the matcher hasn't resolved
      // yet — nothing to seek to in that case.
      if (h.uuid !== null && ctx.matcher.jumpTo(h.uuid) !== "not-found") {
        ctx.setTimeout(() => {
          const mk2 = markEl(h.id);
          if (mk2) flashMark(mk2);
        }, MARK_JUMP_RETRY_MS);
      }
    };

    const removeHighlight = (id: string): void => {
      highlights = highlights.filter((h) => h.id !== id);
      void ctx.storage.conv.set("highlights", highlights);
      // Unwrap every rendered segment so the removal is visible immediately
      // (a highlight can span multiple mark segments).
      document.querySelectorAll(`mark.cc-hl[data-hl-id="${CSS.escape(id)}"]`).forEach((mk) => {
        const parent = mk.parentNode;
        if (!parent) return;
        while (mk.firstChild) parent.insertBefore(mk.firstChild, mk);
        parent.removeChild(mk);
        if (parent instanceof Element) parent.normalize();
      });
      // Tell the highlights feature (features never import each other): its
      // in-memory records still hold this id, and its re-apply loop would
      // re-wrap the mark ~1.5 s later without this broadcast.
      const convId = ctx.storage.convId;
      if (convId) ctx.bus.emit("highlights:removed", { convId, id });
      render();
    };

    /** One Marks row: 🖍 text (click = jump) + ✕ remove. `matched` renders the
     *  scoped-search hit with the query segment marked. */
    const addHlRow = (h: HighlightRecord, q: string | null): void => {
      const row = ownedEl("div", { owner: OWNER, className: "cc-hl-row" });
      const tx = ownedEl("span", { owner: OWNER, className: "cc-hl-text" });
      const raw = normalizeWhitespace(h.text);
      if (q) {
        const i = lower(h.text).indexOf(q);
        if (i >= 0) {
          tx.append(`🖍 ${clip(raw.slice(0, i), 20)}`);
          tx.append(ownedEl("mark", { owner: OWNER, className: "cc-mark", text: raw.slice(i, i + q.length) }));
          tx.append(clip(raw.slice(i + q.length), 30));
        } else {
          tx.textContent = `🖍 ${clip(raw, 58)}`;
        }
      } else {
        tx.textContent = `🖍 ${clip(raw, 58)}`;
      }
      tx.dataset["ccAct"] = act(() => jumpHl(h));
      const x = ownedEl("button", {
        owner: OWNER,
        className: "cc-hl-x",
        text: "✕",
        attrs: { type: "button", title: "Remove highlight" },
      });
      x.dataset["ccAct"] = act(() => removeHighlight(h.id));
      row.append(tx, x);
      refs.list.append(row);
    };

    // ---- export toolbar ----
    // One toolbar builder, two consumers: the Marks tab (highlights) and the
    // Answers tab's 📌 Pinned group — identical markup/classes/flash.

    const chatName = (index: ConversationIndex | null): string =>
      index?.name ??
      document.title.replace(/^([●✓] )+/, "").replace(/ - Claude.*$/, "").trim();

    const stampUtc = (): string =>
      new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";

    const hlMarkdown = (): string => {
      const index = ctx.conversation.current();
      const convId = ctx.storage.convId ?? "";
      const n = highlights.length;
      let md = `# Highlights — ${chatName(index)}\n\n_${n} highlight${
        n === 1 ? "" : "s"
      } · exported ${stampUtc()} · chat id ${convId}_\n\n`;
      for (const h of highlights) md += `> ${h.text.replace(/\n/g, "\n> ")}\n\n`;
      return md;
    };

    /** Pinned answers of the index, in conversation order. */
    const pinnedAnswers = (index: ConversationIndex | null): IndexedMessage[] => {
      const pinSet = new Set(pins);
      return (
        index?.messages.filter((m) => m.sender === "assistant" && pinSet.has(m.uuid)) ?? []
      );
    };

    const pinsMarkdown = (): string => {
      const index = ctx.conversation.current();
      const convId = ctx.storage.convId ?? "";
      const pinnedMsgs = pinnedAnswers(index);
      const n = pinnedMsgs.length;
      let md = `# Pinned from ${chatName(index)}\n\n_${n} pinned answer${
        n === 1 ? "" : "s"
      } · exported ${stampUtc()} · chat id ${convId}_\n\n`;
      pinnedMsgs.forEach((m, i) => {
        md += `## ${i + 1} · ${firstLabelOf(m.text)}\n\n${cleanExportBody(m.text)}\n\n`;
      });
      return md;
    };

    const mkIcon = (svg: string, title: string): HTMLButtonElement => {
      const b = ownedEl("button", {
        owner: OWNER,
        className: "cc-iconbtn",
        attrs: { type: "button", title },
      });
      b.innerHTML = svg; // static constant SVG only
      return b;
    };

    const flashOk = (b: HTMLButtonElement, orig: string): void => {
      b.innerHTML = SVG_OK;
      b.classList.add("cc-ok");
      ctx.setTimeout(() => {
        b.innerHTML = orig;
        b.classList.remove("cc-ok");
      }, FLASH_RESTORE_MS);
    };

    /** The shared "sent ✓" success pulse (companion.css cc-sent-pulse) — the
     *  same brief scale bump + green glow every send surface plays. Cleared by a
     *  managed timer; inert under prefers-reduced-motion (the ✓ is the feedback). */
    const pulseSent = (b: HTMLElement): void => {
      b.classList.add("cc-sent-pulse");
      ctx.setTimeout(() => b.classList.remove("cc-sent-pulse"), PULSE_MS);
    };

    const copyMd = (b: HTMLButtonElement, buildMd: () => string): void => {
      const md = buildMd();
      navigator.clipboard
        .writeText(md)
        .then(() => flashOk(b, SVG_COPY))
        .catch(() => {
          // Clipboard API can be gesture/permission-picky in content scripts.
          const ta = ownedEl("textarea", { owner: OWNER });
          ta.value = md;
          ctx.root.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
          flashOk(b, SVG_COPY);
        });
    };

    const downloadMd = (b: HTMLButtonElement, buildMd: () => string, filename: string): void => {
      const blob = new Blob([buildMd()], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      ctx.setTimeout(() => URL.revokeObjectURL(url), 5000);
      flashOk(b, SVG_DL);
    };

    /** Pending bridge-send button + its correlation token — flashed ✓/red only
     *  by the send-result whose reqId matches (four surfaces share the
     *  contract; a mismatch is another feature's result). */
    let sendPending: { btn: HTMLButtonElement; reqId: string } | null = null;
    /** reqId + scope of the send currently IN FLIGHT (click → result/failsafe),
     *  or null. Re-derived onto the freshly built send button on every render
     *  so the busy face survives the toolbar's frequent rebuilds (store poll /
     *  conversation updates); the scope names which toolbar (pins vs marks). */
    let sendInFlight: { reqId: string; scope: "pins" | "highlights" } | null = null;
    ctx.on("bridge:send-result", ({ ok, reqId }) => {
      const pending = sendPending;
      if (!pending || reqId !== pending.reqId) return;
      sendPending = null;
      if (sendInFlight?.reqId === reqId) sendInFlight = null;
      const b = pending.btn;
      b.classList.remove("cc-send-busy");
      b.removeAttribute("aria-busy");
      if (ok) {
        flashOk(b, SVG_SEND);
        pulseSent(b); // shared success animation, alongside the ✓
      } else {
        b.classList.add("cc-danger-text");
        ctx.setTimeout(() => b.classList.remove("cc-danger-text"), 1600);
      }
    });

    /** The slim export toolbar row: count left, copy ⧉ + download ⬇ (+ send
     *  ✈ to Claude Code for the collection scopes) right. */
    const addExportToolbar = (spec: {
      count: string;
      copyTitle: string;
      dlTitle: string;
      filename: string;
      md: () => string;
      send?: { title: string; scope: "pins" | "highlights" };
    }): void => {
      const row = ownedEl("div", { owner: OWNER, className: "cc-hl-actions" });
      row.append(ownedEl("span", { owner: OWNER, className: "cc-faint", text: spec.count }));
      const btns = ownedEl("div", { owner: OWNER, className: "cc-hl-btns" });
      const bc = mkIcon(SVG_COPY, spec.copyTitle);
      bc.dataset["ccAct"] = act(() => copyMd(bc, spec.md));
      const bd = mkIcon(SVG_DL, spec.dlTitle);
      bd.dataset["ccAct"] = act(() => downloadMd(bd, spec.md, spec.filename));
      btns.append(bc, bd);
      if (spec.send) {
        const send = spec.send;
        const bs = mkIcon(SVG_SEND, bridgeLive ? send.title : SEND_INERT_LABEL);
        if (bridgeLive) {
          // Re-derive the busy face after a rebuild: a send armed before this
          // re-render is still in flight on the freshly built button.
          if (sendInFlight?.scope === send.scope) {
            bs.classList.add("cc-send-busy");
            bs.setAttribute("aria-busy", "true");
          }
          bs.dataset["ccAct"] = act(() => {
            const reqId = crypto.randomUUID();
            sendPending = { btn: bs, reqId };
            sendInFlight = { reqId, scope: send.scope };
            // Immediate in-flight face — dim + breathe the instant it's clicked,
            // not when the ack returns.
            bs.classList.add("cc-send-busy");
            bs.setAttribute("aria-busy", "true");
            // Failsafe: drop the busy face after 8 s if no result ever lands, so
            // it can never stick. reqId-guarded so a newer send keeps ownership.
            ctx.setTimeout(() => {
              if (sendInFlight?.reqId !== reqId) return;
              sendInFlight = null;
              sendPending = null;
              if (bs.isConnected) {
                bs.classList.remove("cc-send-busy");
                bs.removeAttribute("aria-busy");
              }
            }, 8000);
            ctx.bus.emit("bridge:send", { handle: "context", scope: send.scope, body: spec.md(), reqId });
          });
        } else {
          // Inert: greyed, no data-cc-act so the delegated click is a no-op
          // (same treatment as the answer-toolbar's send button).
          bs.classList.add("cc-send-inert");
          bs.setAttribute("aria-label", SEND_INERT_LABEL);
        }
        btns.append(bs);
      }
      row.append(btns);
      refs.list.append(row);
    };

    // ---- pinned rows (Answers tab, 📌 Pinned group) ----

    /** Unpin straight from the outline. Optimistic: drop locally + re-render
     *  now (the storage poll would also converge, this kills the visible
     *  lag), then hand the toggle to the pins feature — the owner — via the
     *  bus (features never import each other). It persists, re-broadcasts
     *  "pins:changed" (toolbar face) and "conversation:updated" (us again). */
    const unpin = (uuid: string): void => {
      pins = pins.filter((u) => u !== uuid);
      ctx.bus.emit("ui:pin-toggle", { uuid });
      render();
    };

    /** One 📌 Pinned-group row: numbered gold label (click = jump) + ✕ unpin
     *  — same row anatomy and classes as the Marks tab's highlight rows, so
     *  pins can be dropped right where they surface. */
    const addPinnedRow = (n: number, m: IndexedMessage): void => {
      const row = ownedEl("div", { owner: OWNER, className: "cc-hl-row" });
      const tx = ownedEl("span", { owner: OWNER, className: "cc-hl-text" });
      tx.append(numSpan(n, true), ` · ${clip(firstLabelOf(m.text), 48)}`);
      tx.dataset["ccAct"] = act(() => jumpMsg(m));
      const x = ownedEl("button", {
        owner: OWNER,
        className: "cc-hl-x",
        text: "✕",
        attrs: { type: "button", title: "Unpin this answer" },
      });
      x.dataset["ccAct"] = act(() => unpin(m.uuid));
      row.append(tx, x);
      refs.list.append(row);
    };

    const addMarksToolbar = (): void => {
      const n = highlights.length;
      addExportToolbar({
        count: `${n} mark${n === 1 ? "" : "s"}`,
        copyTitle: "Copy all highlights as Markdown",
        dlTitle: "Download highlights.md",
        filename: "highlights.md",
        md: hlMarkdown,
        send: { title: "Send all highlights to Claude Code", scope: "highlights" },
      });
    };

    const addPinsToolbar = (n: number): void => {
      addExportToolbar({
        count: `${n} pinned`,
        copyTitle: "Copy pinned answers as Markdown",
        dlTitle: "Download pinned-answers.md",
        filename: "pinned-answers.md",
        md: pinsMarkdown,
        send: { title: "Send all pinned answers to Claude Code", scope: "pins" },
      });
    };

    // ---- tab renders ----

    const renderQuestions = (index: ConversationIndex | null): void => {
      const humans = index?.messages.filter((m) => m.sender === "human") ?? [];
      humans.forEach((m, i) => addNumbered(i + 1, clip(m.text, 58), () => jumpMsg(m)));
    };

    const renderAnswers = (index: ConversationIndex | null): void => {
      const answers = index?.messages.filter((m) => m.sender === "assistant") ?? [];
      const pinSet = new Set(pins);
      const pinned = answers.filter((m) => pinSet.has(m.uuid));
      if (pinned.length > 0) {
        addPinsToolbar(pinned.length);
        addGroup("📌 Pinned");
        for (const m of pinned) {
          // Row with an ✕ (like the Marks tab) — unpin right from the top.
          addPinnedRow(answers.indexOf(m) + 1, m);
        }
        addGroup("All answers");
      }
      answers.forEach((m, i) => {
        const heads = headingsOf(m.text);
        const firstHead = heads[0];
        const isPinned = pinSet.has(m.uuid);
        addNumbered(i + 1, clip(firstLabelOf(m.text), 52), () => jumpMsg(m, firstHead?.txt), {
          gold: isPinned,
          pinMarker: isPinned,
          bold: true,
        });
        for (const hh of heads.slice(1)) {
          const it = makeItem({ sub: true, lvl: hh.lvl });
          it.textContent = clip(hh.txt, 52);
          it.dataset["ccAct"] = act(() => jumpMsg(m, hh.txt));
          refs.list.append(it);
        }
      });
    };

    const renderMarks = (): void => {
      if (highlights.length === 0) {
        addHint("No highlights yet — select text in an answer and press 🖍 Highlight.");
        return;
      }
      addMarksToolbar();
      for (const h of highlights) addHlRow(h, null);
    };

    // ---- scoped search ----

    const renderSearch = (q: string, index: ConversationIndex | null): void => {
      let hits = 0;

      if (activeTab === "h") {
        for (const h of highlights.filter((x) => lower(x.text).includes(q))) {
          hits++;
          addHlRow(h, q);
        }
      } else {
        const wanted = activeTab === "q" ? "human" : "assistant";
        const pool = index?.messages.filter((m) => m.sender === wanted) ?? [];
        pool.forEach((m, pi) => {
          const raw = normalizeWhitespace(m.text);
          const i = raw.toLowerCase().indexOf(q);
          if (i < 0) return;
          hits++;
          const start = Math.max(0, i - 35);
          const it = makeItem({});
          it.append(ownedEl("span", { owner: OWNER, className: "cc-faint", text: `#${pi + 1}` }));
          it.append(` ${start > 0 ? "…" : ""}${raw.slice(start, i)}`);
          it.append(ownedEl("mark", { owner: OWNER, className: "cc-mark", text: raw.slice(i, i + q.length) }));
          it.append(clip(raw.slice(i + q.length), 40));
          it.dataset["ccAct"] = act(() => jumpMsg(m));
          refs.list.append(it);
        });
      }

      const head = ownedEl("div", {
        owner: OWNER,
        className: "cc-hits",
        text: `${hits} match${hits === 1 ? "" : "es"}`,
      });
      refs.list.insertBefore(head, refs.list.firstChild);
    };

    // ---- master render ----

    const render = (): void => {
      actions.clear();
      actionSeq = 0;
      refs.list.replaceChildren();
      const index = ctx.conversation.current();
      if (index?.source === "dom") {
        addHint("Partial index — API unavailable, showing rendered messages only.");
      }
      const q = lower(refs.searchInput.value).trim();
      if (q.length >= SEARCH_MIN) {
        renderSearch(q, index);
        return;
      }
      if (activeTab === "q") renderQuestions(index);
      else if (activeTab === "a") renderAnswers(index);
      else renderMarks();
    };

    const updateTabs = (): void => {
      for (const tab of refs.tabbar.querySelectorAll<HTMLElement>(".cc-tab")) {
        tab.dataset["active"] = tab.dataset["tab"] === activeTab ? "1" : "0";
      }
      refs.searchInput.placeholder = PLACEHOLDER[activeTab];
    };

    // ---- wiring (all through ctx-managed resources) ----

    ctx.listen(refs.tabbar, "click", (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>(".cc-tab") : null;
      const tab = target?.dataset["tab"];
      if (tab !== "q" && tab !== "a" && tab !== "h") return;
      activeTab = tab;
      updateTabs();
      render();
    });

    ctx.listen(refs.list, "click", (e: MouseEvent) => {
      const target =
        e.target instanceof Element ? e.target.closest<HTMLElement>("[data-cc-act]") : null;
      if (!target) return;
      const fn = actions.get(target.dataset["ccAct"] ?? "");
      if (fn) fn();
    });

    ctx.listen(refs.searchInput, "input", () => render());
    ctx.listen(refs.reindexBtn, "click", () => {
      void ctx.conversation.ensure(true);
    });

    ctx.on("conversation:indexed", () => render());
    ctx.on("conversation:updated", () => render());
    // Pins are bus-authoritative (the pins feature broadcasts the FULL set on
    // every toggle). Without this, a toolbar unpin left our poll-fed mirror
    // stale for up to 1.2 s — the 📌 row lingered, and clicking its ✕ then
    // RE-pinned the answer (ui:pin-toggle is a pure toggle). The storage poll
    // below stays for highlights.
    ctx.on("pins:changed", ({ pinned }) => {
      pins = [...pinned];
      render();
    });
    // Live/inert state for the export-toolbar send buttons. The claude-code-
    // bridge feature is the single producer (re-broadcasts on cold start); we
    // only re-render on a live↔inert transition so the toolbars rebuild.
    ctx.on("bridge:changed", ({ sessions }) => {
      const live = sessions.length > 0;
      if (live === bridgeLive) return;
      bridgeLive = live;
      render();
    });

    // Pins/highlights arrive from sibling features via storage — poll for
    // their writes (decoupled; features never import features).
    const loadStores = async (): Promise<void> => {
      const [p, h] = await Promise.all([
        ctx.storage.conv.get("pins"),
        ctx.storage.conv.get("highlights"),
      ]);
      if (ctx.signal.aborted) return;
      const changed =
        JSON.stringify(p) !== JSON.stringify(pins) ||
        JSON.stringify(h) !== JSON.stringify(highlights);
      pins = p;
      highlights = h;
      if (changed) render();
    };
    ctx.setInterval(() => void loadStores(), STORE_POLL_MS);

    // ---- boot ----
    updateTabs();
    render();
    void loadStores();
    void ctx.conversation.ensure();
  },
};
