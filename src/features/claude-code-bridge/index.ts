/**
 * Claude Code bridge — content half (Tier 3, SESSION scope). The always-on-top
 * companion to the background WS manager (./manager.ts): it mirrors the roster
 * the background pushes, owns the composer session chip + the conversation↔
 * session binding, assembles handoffs for the answer-toolbar's send action, and
 * relays inbound `push_to_composer` into the composer (never auto-sends).
 *
 * Session scope because the chip rides the composer button row, which survives
 * conversation switches (it dies with the tab) — the same reason mini-window /
 * undo-send / usage are session-scoped.
 *
 * Cross-feature contract (features never import features — bus + stable ids):
 * - Broadcasts "bridge:changed" { sessions, boundSessionId, paired } on every
 *   roster/binding change and re-broadcasts on conversation index events so the
 *   conversation-scoped answer-toolbar cold-starts its send button.
 * - Subscribes to "bridge:send" (the toolbar's action) → assembles + pushes →
 *   answers with "bridge:send-result".
 *
 * The binding is in EXTENSION MEMORY ONLY and only while the bound session's
 * socket is open (spec §4): nothing persisted, no expiry. When the roster drops
 * the bound session the binding re-derives (auto-bind if one remains, else the
 * chip disappears and the send action goes inert).
 */

import { browser } from "wxt/browser";
import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl, setGeometry } from "@/ui/root";
import {
  isBridgeBackgroundMessage,
  MAX_PUSH_MARKDOWN_CHARS,
  type BridgeComposerReply,
  type BridgeReadReply,
  type BridgeSession,
  type BridgeStatus,
  type PushMeta,
} from "@/shared/bridge-protocol";
import {
  assembleHandoff,
  buildAnswerBody,
  buildHandoffMarkdown,
  fenceNonce,
  type HandoffMeta,
  type HandoffScope,
} from "@/shared/handoff";
import type { ConversationIndex } from "@/core/conversation-store";
import { indexFromConversation, runBridgeRead, type BridgeReadDeps } from "./reads";

const OWNER = "claude-code-bridge";
const PLACE_MS = 700;

/** lucide `circle-dot` glyph substitute — a simple ring dot in text. */
const DOT = "◍";
const CARET = "▾";

export const claudeCodeBridge: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "session",

  mount(ctx: FeatureContext) {
    let sessions: BridgeSession[] = [];
    let paired = false;
    /** In-memory only, cleared when the bound socket closes (spec §4). */
    let boundSessionId: string | null = null;

    // ---- roster + binding ---------------------------------------------------
    const boundSession = (): BridgeSession | null =>
      sessions.find((s) => s.sessionId === boundSessionId) ?? null;

    /** One live session → auto-bind; several → keep the explicit pick while it
     *  stays live, else default to the newest; none → clear. */
    const reconcileBinding = (): void => {
      if (sessions.length === 0) {
        boundSessionId = null;
      } else if (!sessions.some((s) => s.sessionId === boundSessionId)) {
        boundSessionId = sessions[0]?.sessionId ?? null; // roster is newest-first
      }
    };

    const broadcast = (): void => {
      ctx.bus.emit("bridge:changed", { sessions, boundSessionId, paired });
    };

    const applyStatus = (status: BridgeStatus): void => {
      sessions = status.sessions;
      paired = status.paired;
      reconcileBinding();
      renderChip();
      place(); // reflect appear/disappear immediately, not on the next tick
      broadcast();
    };

    // ---- the composer session chip -----------------------------------------
    const slot = ownedEl("div", {
      owner: OWNER,
      className: "cc-composer-slot",
      attrs: { id: "cc-bridge-inline" },
    });
    const chipBtn = ownedEl("button", {
      owner: OWNER,
      className: "cc-ccb-chip",
      attrs: { type: "button" },
    });
    slot.appendChild(chipBtn);
    ctx.onCleanup(() => slot.remove());

    // dropdown (top-level UI under #cc-root, opens upward over the composer)
    const menu = ownedEl("div", {
      owner: OWNER,
      className: "cc-popover cc-ccb-menu cc-hidden",
      attrs: { id: "cc-ccb-menu", role: "listbox", "aria-label": "Claude Code sessions" },
    });
    ctx.root.appendChild(menu);
    ctx.onCleanup(() => menu.remove());

    const disambiguated = (s: BridgeSession): boolean =>
      sessions.filter((o) => o.project === s.project).length >= 2;

    const hhmm = (iso: string | undefined): string => {
      if (!iso) return "";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };

    /** The chip's visible label for a session, disambiguated when needed. */
    const labelFor = (s: BridgeSession): string => {
      if (!disambiguated(s)) return s.project;
      const time = hhmm(s.startedAt);
      return `${s.project} ·${s.shortId}${time ? ` — ${time}` : ""}`;
    };

    const renderChip = (): void => {
      const bound = boundSession();
      if (!bound) {
        menu.classList.add("cc-hidden");
        if (!paired) return; // unpaired: chip removed by place() below
        // Paired but no live session — a visible idle state, so "connected vs
        // not" is never a guess. Click rescans the loopback ports on demand.
        chipBtn.classList.add("cc-ccb-idle");
        chipBtn.replaceChildren(
          ownedEl("span", { owner: OWNER, className: "cc-ccb-dot", text: DOT }),
          ownedEl("span", { owner: OWNER, className: "cc-ccb-label", text: "not connected" }),
        );
        chipBtn.title =
          "No Claude Code session connected — click to check now. Start Claude Code in a project folder to connect.";
        chipBtn.setAttribute("aria-label", chipBtn.title);
        chipBtn.removeAttribute("aria-haspopup");
        chipBtn.removeAttribute("aria-expanded");
        return;
      }
      chipBtn.classList.remove("cc-ccb-idle", "cc-ccb-busy");
      chipBtn.replaceChildren(
        ownedEl("span", { owner: OWNER, className: "cc-ccb-dot", text: DOT }),
        ownedEl("span", { owner: OWNER, className: "cc-ccb-label", text: labelFor(bound) }),
        ownedEl("span", { owner: OWNER, className: "cc-ccb-caret", text: CARET }),
      );
      const multi = sessions.length >= 2;
      chipBtn.title = multi
        ? `Sending to ${bound.project} (${bound.path}) — click to switch session`
        : `Sending to ${bound.project} (${bound.path})`;
      chipBtn.setAttribute("aria-label", chipBtn.title);
      if (multi) {
        chipBtn.setAttribute("aria-haspopup", "listbox");
        chipBtn.setAttribute("aria-expanded", menu.classList.contains("cc-hidden") ? "false" : "true");
      } else {
        chipBtn.removeAttribute("aria-haspopup");
        chipBtn.removeAttribute("aria-expanded");
        menu.classList.add("cc-hidden");
      }
    };

    const closeMenu = (): void => {
      menu.classList.add("cc-hidden");
      chipBtn.setAttribute("aria-expanded", "false");
    };

    const openMenu = (): void => {
      menu.replaceChildren();
      for (const s of sessions) {
        const row = ownedEl("div", {
          owner: OWNER,
          className: "cc-ccb-opt" + (s.sessionId === boundSessionId ? " cc-sel" : ""),
          attrs: { role: "option", "aria-selected": String(s.sessionId === boundSessionId), tabindex: "0" },
        });
        row.dataset["sid"] = s.sessionId;
        const time = hhmm(s.startedAt);
        row.append(
          ownedEl("span", { owner: OWNER, className: "cc-ccb-opt-name", text: s.project }),
          ownedEl("span", {
            owner: OWNER,
            className: "cc-ccb-opt-sub",
            text: `·${s.shortId}${time ? ` — ${time}` : ""}  ·  ${s.path}`,
          }),
        );
        menu.appendChild(row);
      }
      const r = chipBtn.getBoundingClientRect();
      setGeometry(menu, { left: Math.max(8, r.left), top: r.top - 8, transform: "translateY(-100%)" });
      menu.classList.remove("cc-hidden");
      chipBtn.setAttribute("aria-expanded", "true");
    };

    const pick = (sessionId: string): void => {
      if (sessions.some((s) => s.sessionId === sessionId)) {
        boundSessionId = sessionId;
        renderChip();
        broadcast();
      }
      closeMenu();
    };

    /** Manual rescan (idle-chip click): wake the background scanner now instead
     *  of waiting for its next heartbeat. The immediate reply reflects the scan
     *  kick-off; freshly welcomed sessions arrive via the roster broadcast. */
    const rescan = (): void => {
      chipBtn.classList.add("cc-ccb-busy");
      const settle = (): void => chipBtn.classList.remove("cc-ccb-busy");
      void browser.runtime
        .sendMessage({ type: "cc:bridge:rescan" })
        .then((status: unknown) => {
          if (ctx.signal.aborted) return;
          if (typeof status === "object" && status !== null && "sessions" in status) {
            applyStatus(status as BridgeStatus);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (!ctx.signal.aborted) ctx.setTimeout(settle, 400);
        });
    };

    ctx.listen(chipBtn, "click", (ev: MouseEvent) => {
      ev.stopPropagation();
      if (sessions.length === 0) {
        if (paired) rescan();
        return;
      }
      if (sessions.length < 2) return; // one session → nothing to switch to
      if (menu.classList.contains("cc-hidden")) openMenu();
      else closeMenu();
    });
    ctx.listen(menu, "click", (ev: MouseEvent) => {
      const t = ev.target instanceof Element ? ev.target : null;
      const row = t?.closest<HTMLElement>(".cc-ccb-opt");
      if (row?.dataset["sid"]) pick(row.dataset["sid"]);
    });
    ctx.listen(document, "mousedown", (ev: MouseEvent) => {
      if (menu.classList.contains("cc-hidden")) return;
      const t = ev.target;
      if (t instanceof Element && (t.closest("#cc-ccb-menu") || t.closest("#cc-bridge-inline"))) return;
      closeMenu();
    });
    ctx.listen(document, "keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !menu.classList.contains("cc-hidden")) closeMenu();
    });

    // ---- composer-group placement (rides the shared #cc-composer-grp) --------
    // undo-send / usage create and park the group in claude's composer action
    // row; the chip joins it as an additive sibling (never claude's own DOM).
    const place = (): void => {
      const group = document.getElementById("cc-composer-grp");
      // Paired → the chip is always present (bound session OR the idle state);
      // unpaired → no chip at all.
      if (!group || (!paired && boundSession() === null)) {
        if (slot.parentElement) slot.remove();
        return;
      }
      if (slot.parentElement !== group) group.appendChild(slot);
      else if (group.lastElementChild !== slot) group.appendChild(slot); // keep last
    };
    ctx.setInterval(place, PLACE_MS);

    // ---- send orchestration (answer-toolbar → here) --------------------------
    const appVersion = browser.runtime.getManifest().version;

    const assemble = (
      handle: "continue" | "review" | "context",
      scope: HandoffScope,
      uuid: string | undefined,
      selectionText: string | undefined,
    ): { markdown: string; meta: PushMeta } | { error: string } => {
      const bound = boundSession();
      if (!bound) return { error: "No Claude Code session is connected." };
      const index = ctx.conversation.current();
      if (!index) return { error: "couldn't read the conversation" };

      const sentAt = new Date().toISOString();
      const nonce = fenceNonce();
      const base: HandoffMeta = {
        handle,
        scope,
        source_url: `https://claude.ai/chat/${index.convId}`,
        source_id: index.convId,
        source_title: index.name,
        sent_at: sentAt,
        app_version: appVersion,
        body_fence: nonce,
      };

      let body: string;
      let meta: HandoffMeta;
      if (scope === "selection") {
        const text = (selectionText ?? "").trim();
        if (!text) return { error: "Nothing was selected." };
        body = text;
        meta = base;
      } else if (scope === "answer") {
        const msg = index.messages.find((m) => m.uuid === uuid);
        if (!msg) return { error: "couldn't read that answer" };
        body = buildAnswerBody(index.name, msg.text);
        meta = { ...base, answer_id: uuid ?? "", message_count: 1 };
      } else {
        body = buildHandoffMarkdown(index, "all");
        meta = { ...base, message_count: index.messages.length };
      }

      const markdown = assembleHandoff(meta, body, nonce);
      // The bridge hard-closes frames over its 8 MiB cap; without this guard
      // an oversized handoff reads as a bogus "session disconnected".
      if (markdown.length > MAX_PUSH_MARKDOWN_CHARS) {
        return {
          error:
            "This handoff is too large to send in one piece. Send a single answer or a selection instead.",
        };
      }
      return {
        markdown,
        meta: {
          handle,
          scope,
          source_id: base.source_id,
          source_title: index.name,
          sent_at: sentAt,
        },
      };
    };

    ctx.on("bridge:send", ({ handle, scope, uuid, selectionText }) => {
      const bound = boundSession();
      if (!bound) {
        ctx.bus.emit("bridge:send-result", { ok: false, reason: "No session connected." });
        return;
      }
      const built = assemble(handle, scope, uuid, selectionText);
      if ("error" in built) {
        ctx.bus.emit("bridge:send-result", { ok: false, reason: built.error });
        return;
      }
      const id = crypto.randomUUID();
      void browser.runtime
        .sendMessage({
          type: "cc:bridge:push",
          sessionId: bound.sessionId,
          id,
          markdown: built.markdown,
          meta: built.meta,
        })
        .then((reply: unknown) => {
          if (ctx.signal.aborted) return;
          const ok = typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === true;
          const reason =
            typeof reply === "object" && reply !== null
              ? ((reply as { reason?: unknown }).reason as string | undefined)
              : undefined;
          ctx.bus.emit("bridge:send-result", ok ? { ok: true } : { ok: false, reason: reason ?? "nothing sent" });
        })
        .catch(() => {
          if (ctx.signal.aborted) return;
          ctx.bus.emit("bridge:send-result", { ok: false, reason: "session disconnected — nothing sent" });
        });
    });

    // ---- reverse-direction READ tools (background → live conversation) -------
    // Read-only: answered from the SAME conversation index / conv-scoped storage
    // the outline+pins+notes features use — never the DOM, never a new selector.
    // "current" resolves to this (last-focused) tab's conversation (spec §4).
    const loadIndex = async (idOrCurrent: string): Promise<ConversationIndex | null> => {
      const cur = ctx.storage.convId;
      const id = idOrCurrent === "current" ? cur : idOrCurrent;
      if (!id) return null;
      if (id === cur) {
        return ctx.conversation.current() ?? (await ctx.conversation.ensure());
      }
      const res = await ctx.api.getConversation(id, ctx.signal);
      return res.ok ? indexFromConversation(res.data) : null;
    };
    const readDeps: BridgeReadDeps = {
      getConversations: (opts) => ctx.api.getConversations(opts, ctx.signal),
      loadIndex,
      currentConvId: () => ctx.storage.convId,
      getConv: (convId, kind) => ctx.storage.getConv(convId, kind),
    };

    // ---- inbound push_to_composer relay (background → composer draft) --------
    // NEVER sends — inserts a draft for the human to review (spec §1 non-goal).
    const onRuntimeMessage = (
      message: unknown,
    ): Promise<BridgeComposerReply | BridgeReadReply> | undefined => {
      if (!isBridgeBackgroundMessage(message)) return undefined;
      if (message.type === "cc:bridge:roster") {
        applyStatus(message.status);
        return undefined;
      }
      if (message.type === "cc:bridge:read") {
        return runBridgeRead(readDeps, message.method, message.params).catch(
          (): BridgeReadReply => ({
            ok: false,
            code: "internal",
            message: "The extension failed to read that.",
          }),
        );
      }
      // cc:bridge:push-to-composer
      const drafted = ctx.composer.insertText(message.text);
      return Promise.resolve({ ok: drafted, drafted });
    };
    try {
      browser.runtime.onMessage.addListener(onRuntimeMessage);
      ctx.onCleanup(() => browser.runtime.onMessage.removeListener(onRuntimeMessage));
    } catch {
      // messaging unavailable — the bridge is simply absent
    }

    // ---- last-focused-tab pings (so inbound drafts land on the right tab) ----
    const pingFocus = (): void => {
      if (document.visibilityState !== "visible") return;
      void browser.runtime.sendMessage({ type: "cc:bridge:tab-focus" }).catch(() => undefined);
    };
    ctx.listen(window, "focus", pingFocus);
    ctx.listen(document, "visibilitychange", pingFocus);

    // ---- cold start ---------------------------------------------------------
    void browser.runtime
      .sendMessage({ type: "cc:bridge:status" })
      .then((status: unknown) => {
        if (ctx.signal.aborted) return;
        if (typeof status === "object" && status !== null && "sessions" in status) {
          applyStatus(status as BridgeStatus);
        }
      })
      .catch(() => undefined);
    pingFocus();

    // Re-broadcast so the conversation-scoped answer-toolbar cold-starts after
    // a chat switch (mini-window / pins pattern).
    ctx.on("conversation:indexed", broadcast);
    ctx.on("conversation:updated", broadcast);

    place();
    broadcast();
  },
};
