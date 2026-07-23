/**
 * Command palette — session scope.
 *
 * Trigger: **Ctrl+Shift+K** (Cmd+Shift+K on Mac — plain Ctrl/Cmd+K is taken by
 * claude.ai's own search) or the ⌘ button in the header cluster (which emits
 * bus `ui:palette-toggle`; features never import each other).
 *
 * A centered overlay input with fuzzy filtering over three groups:
 * - Actions   — switch theme (each preset), fold/unfold all, open notes,
 *               open export (Copy for Claude Code), toggle undo-send.
 * - This chat — jump to any message in the current conversation
 *               (ctx.conversation.current() → ctx.matcher.jumpTo).
 * - Chats     — jump to any of YOUR conversations (api.getConversations,
 *               fetched fresh on every open; select navigates to the chat).
 *
 * Keyboard: ↑/↓ move, Enter runs, Esc closes. Mouse: hover selects, click
 * runs. Outside-click on the scrim closes.
 *
 * Standards: managed ctx resources only; all visuals from companion.css via
 * var(--cc-*); top-level UI under #cc-root; API failures degrade to a
 * quiet "couldn't load" row, never an error surface.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import type { ConversationStub } from "@/api/types";
import { ownedEl } from "@/ui/root";
import { PRESET_LIST } from "@/theme/presets";
import { clip, normalizeWhitespace } from "@/shared/text";
import { relativeTime } from "@/shared/time";

const OWNER = "command-palette";

const MAX_PER_GROUP = 12;
const CONVERSATIONS_FETCH_LIMIT = 100;
const UNDO_ENABLE_SECONDS = 5;

type Group = "Actions" | "This chat" | "Chats";
const GROUP_ORDER: readonly Group[] = ["Actions", "This chat", "Chats"];

interface PaletteItem {
  group: Group;
  label: string;
  /** Faint right-aligned hint (e.g. "#12", "2h ago"). */
  hint: string;
  run: () => void;
}

/**
 * Subsequence fuzzy score: every query char must appear in order. Contiguous
 * runs and word starts score higher; long haystacks get a mild penalty.
 * Returns null when the query does not match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t.charAt(i) !== q.charAt(qi)) continue;
    score += 1;
    if (i === last + 1) score += 3; // contiguous run
    if (i === 0 || /[\s\p{P}]/u.test(t.charAt(i - 1))) score += 2; // word start
    last = i;
    qi++;
  }
  if (qi < q.length) return null;
  return score - Math.floor(t.length / 40);
}

export const commandPalette: FeatureModule = {
  id: "command-palette",
  tier: 3,
  scope: "session",

  mount(ctx: FeatureContext) {
    // ---- DOM (hidden until opened) -----------------------------------------
    const scrim = ownedEl("div", {
      owner: OWNER,
      className: "cc-pal-scrim cc-hidden",
      attrs: { id: "cc-pal-scrim" },
    });
    const panel = ownedEl("div", {
      owner: OWNER,
      className: "cc-hidden",
      attrs: { id: "cc-palette", role: "dialog", "aria-label": "Command palette" },
    });
    const input = ownedEl("input", {
      owner: OWNER,
      className: "cc-input cc-pal-input",
      attrs: {
        type: "text",
        placeholder: "Jump to a chat or message, run an action…",
        "aria-label": "Command palette search",
        autocomplete: "off",
        spellcheck: "false",
      },
    });
    const list = ownedEl("div", {
      owner: OWNER,
      className: "cc-pal-list",
      attrs: { role: "listbox" },
    });
    panel.append(input, list);
    ctx.root.append(scrim, panel);

    // ---- state ---------------------------------------------------------------
    let open = false;
    let openToken = 0; // invalidates in-flight conversation fetches
    let items: PaletteItem[] = [];
    let visible: PaletteItem[] = [];
    let activeIndex = 0;
    let convRows: PaletteItem[] = [];
    let convStatus: "loading" | "ready" | "failed" = "loading";

    // ---- item builders ---------------------------------------------------------
    const buildActionItems = (undoDelaySeconds: number): PaletteItem[] => {
      const acts: PaletteItem[] = [];
      for (const preset of PRESET_LIST) {
        acts.push({
          group: "Actions",
          label: `Theme: ${preset.name}`,
          hint: "theme",
          run: () => void ctx.storage.setSetting("activePresetId", preset.id),
        });
      }
      acts.push(
        {
          group: "Actions",
          label: "Find in conversation — search every message",
          hint: "action",
          // Conversation-scoped subscriber (find-in-conversation); outside a
          // chat this is a quiet no-op.
          run: () => ctx.bus.emit("ui:find-toggle", {}),
        },
        {
          group: "Actions",
          label: "Pin this answer on top — floating mini-window",
          hint: "action",
          // Session-scoped subscriber (mini-window) TOGGLES the answer
          // nearest the viewport center; outside a chat there is nothing to
          // resolve and it's a quiet no-op.
          run: () => ctx.bus.emit("ui:mini-window-popout", {}),
        },
        {
          group: "Actions",
          label: "Toggle Enter behavior — Enter for newline, Ctrl/Cmd+Enter to send",
          hint: "action",
          // Writes settings.enterToNewline; the enter-behavior feature reacts
          // via storage.onChanged (features never import each other).
          run: () =>
            void ctx.storage
              .getSettings()
              .then((s) => ctx.storage.setSetting("enterToNewline", !s.enterToNewline)),
        },
        {
          group: "Actions",
          label: "Toggle secret detection — warn when a draft holds a key or password",
          hint: "action",
          // Writes settings.secretGuardOn; the status bar's draft scanner
          // reacts via storage.onChanged (features never import each other).
          run: () =>
            void ctx.storage
              .getSettings()
              .then((s) => ctx.storage.setSetting("secretGuardOn", !s.secretGuardOn)),
        },
        {
          group: "Actions",
          label: "Toggle truncation guard — continue cut-off answers",
          hint: "action",
          // Writes settings.truncationGuardOn; the truncation-guard feature
          // reacts via storage.onChanged (features never import each other).
          run: () =>
            void ctx.storage
              .getSettings()
              .then((s) => ctx.storage.setSetting("truncationGuardOn", !s.truncationGuardOn)),
        },
        {
          group: "Actions",
          label: "Toggle fence fixer — repair runaway code blocks (display only)",
          hint: "action",
          // Writes settings.fenceFixerOn; the fence-fixer feature reacts via
          // storage.onChanged.
          run: () =>
            void ctx.storage
              .getSettings()
              .then((s) => ctx.storage.setSetting("fenceFixerOn", !s.fenceFixerOn)),
        },
        {
          group: "Actions",
          label: "Toggle regen safety net — keep answers replaced by Retry",
          hint: "action",
          // Writes settings.regenSafetyNetOn; the regen-safety-net feature
          // reacts via storage.onChanged.
          run: () =>
            void ctx.storage
              .getSettings()
              .then((s) => ctx.storage.setSetting("regenSafetyNetOn", !s.regenSafetyNetOn)),
        },
        {
          group: "Actions",
          label: "Toggle math check — recompute arithmetic in answers",
          hint: "action",
          // Writes settings.mathCheckerOn; the math-checker feature reacts
          // via storage.onChanged (features never import each other).
          run: () =>
            void ctx.storage
              .getSettings()
              .then((s) => ctx.storage.setSetting("mathCheckerOn", !s.mathCheckerOn)),
        },
        {
          group: "Actions",
          label: "Toggle live checklists — tickable steps with per-chat memory",
          hint: "action",
          // Writes settings.liveChecklistsOn; the live-checklists feature
          // reacts via storage.onChanged (features never import each other).
          run: () =>
            void ctx.storage
              .getSettings()
              .then((s) => ctx.storage.setSetting("liveChecklistsOn", !s.liveChecklistsOn)),
        },
        {
          group: "Actions",
          label: "Selector health — self-healing anchors into claude.ai",
          hint: "action",
          // Session-scoped subscriber (selector-health) — always lands.
          run: () => ctx.bus.emit("ui:selector-health-toggle", {}),
        },
        {
          group: "Actions",
          label: "Fold all messages",
          hint: "action",
          run: () => ctx.bus.emit("fold:all", { folded: true }),
        },
        {
          group: "Actions",
          label: "Unfold all messages",
          hint: "action",
          run: () => ctx.bus.emit("fold:all", { folded: false }),
        },
        {
          group: "Actions",
          label: "Open notes",
          hint: "action",
          // The header cluster advertises its notes button by stable id for
          // programmatic opens (its own documented mount-point contract).
          run: () => document.getElementById("cc-btn-notes")?.click(),
        },
        {
          group: "Actions",
          label: "Open export · Copy for Claude Code",
          hint: "action",
          run: () => document.getElementById("cc-btn-gear")?.click(),
        },
        undoDelaySeconds > 0
          ? {
              group: "Actions",
              label: `Undo-send: disable (currently ${undoDelaySeconds}s)`,
              hint: "action",
              run: () => void ctx.storage.setSetting("undoDelaySeconds", 0),
            }
          : {
              group: "Actions",
              label: `Undo-send: enable (${UNDO_ENABLE_SECONDS}s delay)`,
              hint: "action",
              run: () =>
                void ctx.storage.setSetting("undoDelaySeconds", UNDO_ENABLE_SECONDS),
            },
      );
      return acts;
    };

    const buildMessageItems = (): PaletteItem[] => {
      const index = ctx.conversation.current();
      if (!index) return [];
      return index.messages.map((m) => ({
        group: "This chat" as const,
        label: `${m.sender === "human" ? "You" : "Claude"} · ${clip(
          normalizeWhitespace(m.text),
          80,
        )}`,
        hint: `#${m.index + 1}`,
        run: () => {
          ctx.matcher.jumpTo(m.uuid);
        },
      }));
    };

    const buildConvItems = (stubs: ConversationStub[]): PaletteItem[] =>
      stubs.map((c) => ({
        group: "Chats" as const,
        label: `${c.is_starred ? "★ " : ""}${c.name || "(untitled)"}`,
        hint: relativeTime(c.updated_at),
        run: () => {
          if (c.uuid === ctx.storage.convId) return; // already here
          // Full navigation — claude's SPA router ignores outside pushState;
          // the nav watcher re-scopes everything after the load.
          location.assign(`/chat/${c.uuid}`);
        },
      }));

    // ---- rendering ---------------------------------------------------------------
    const render = (): void => {
      const query = input.value.trim();

      const scored: Array<{ item: PaletteItem; score: number }> = [];
      for (const item of items) {
        const score = fuzzyScore(query, item.label);
        if (score !== null) scored.push({ item, score });
      }
      if (query) scored.sort((a, b) => b.score - a.score);

      visible = [];
      list.replaceChildren();
      for (const group of GROUP_ORDER) {
        const rows = scored.filter((s) => s.item.group === group).slice(0, MAX_PER_GROUP);
        if (group === "Chats" && convStatus !== "ready" && rows.length === 0) {
          list.append(
            ownedEl("div", { owner: OWNER, className: "cc-pal-group", text: group }),
            ownedEl("div", {
              owner: OWNER,
              className: "cc-pal-empty",
              text: convStatus === "loading" ? "Loading your chats…" : "Couldn't load chats",
            }),
          );
          continue;
        }
        if (rows.length === 0) continue;
        list.append(ownedEl("div", { owner: OWNER, className: "cc-pal-group", text: group }));
        for (const { item } of rows) {
          const i = visible.length;
          visible.push(item);
          const row = ownedEl("div", {
            owner: OWNER,
            className: "cc-pal-item",
            attrs: { role: "option", "data-cc-index": String(i) },
          });
          row.append(
            ownedEl("span", { owner: OWNER, className: "cc-pal-label", text: item.label }),
            ownedEl("span", { owner: OWNER, className: "cc-pal-hint", text: item.hint }),
          );
          list.appendChild(row);
        }
      }
      if (visible.length === 0) {
        list.appendChild(
          ownedEl("div", { owner: OWNER, className: "cc-pal-empty", text: "No matches" }),
        );
      }
      activeIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));
      paintActive();
    };

    const paintActive = (): void => {
      const rows = list.querySelectorAll<HTMLElement>(".cc-pal-item");
      rows.forEach((row) => {
        const i = Number(row.getAttribute("data-cc-index"));
        if (i === activeIndex) {
          row.setAttribute("data-active", "1");
          row.scrollIntoView({ block: "nearest" });
        } else {
          row.removeAttribute("data-active");
        }
      });
    };

    // ---- open / close -----------------------------------------------------------
    const close = (): void => {
      if (!open) return;
      open = false;
      openToken++;
      scrim.classList.add("cc-hidden");
      panel.classList.add("cc-hidden");
      input.value = "";
    };

    const openPalette = (): void => {
      if (open) return;
      open = true;
      const token = ++openToken;
      activeIndex = 0;
      convStatus = "loading";
      convRows = [];
      items = [...buildActionItems(0), ...buildMessageItems()];
      scrim.classList.remove("cc-hidden");
      panel.classList.remove("cc-hidden");
      render();
      input.focus();

      // Undo-send label reflects the live setting (async, quick).
      void ctx.storage.getSettings().then((s) => {
        if (token !== openToken) return;
        items = [...buildActionItems(s.undoDelaySeconds), ...buildMessageItems(), ...convRows];
        render();
      });

      // Conversation list — fetched fresh on every open.
      void ctx.api
        .getConversations({ limit: CONVERSATIONS_FETCH_LIMIT }, ctx.signal)
        .then((res) => {
          if (token !== openToken) return;
          if (res.ok) {
            convStatus = "ready";
            convRows = buildConvItems(res.data);
            items = [...items.filter((i) => i.group !== "Chats"), ...convRows];
          } else {
            convStatus = "failed"; // quiet degradation
          }
          render();
        });
    };

    const toggle = (): void => {
      if (open) close();
      else openPalette();
    };

    // ---- triggers ---------------------------------------------------------------
    // Ctrl+Shift+K / Cmd+Shift+K, captured ahead of the page's own handlers.
    ctx.listen(
      window,
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.code === "KeyK" && ev.shiftKey && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
          ev.preventDefault();
          ev.stopPropagation();
          toggle();
        }
      },
      { capture: true },
    );
    ctx.on("ui:palette-toggle", () => toggle());

    // ---- interaction ----------------------------------------------------------
    ctx.listen(input, "input", () => {
      activeIndex = 0;
      render();
    });

    ctx.listen(input, "keydown", (ev: KeyboardEvent) => {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (visible.length > 0) activeIndex = (activeIndex + 1) % visible.length;
        paintActive();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (visible.length > 0) {
          activeIndex = (activeIndex - 1 + visible.length) % visible.length;
        }
        paintActive();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const item = visible[activeIndex];
        if (item) {
          close();
          item.run();
        }
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close();
      }
    });

    // Keep palette keystrokes out of claude's global shortcut handlers.
    ctx.listen(panel, "keydown", (ev: KeyboardEvent) => ev.stopPropagation());

    ctx.listen(list, "mousemove", (ev: MouseEvent) => {
      const row =
        ev.target instanceof Element ? ev.target.closest<HTMLElement>(".cc-pal-item") : null;
      if (!row) return;
      const i = Number(row.getAttribute("data-cc-index"));
      if (Number.isInteger(i) && i !== activeIndex) {
        activeIndex = i;
        paintActive();
      }
    });
    ctx.listen(list, "click", (ev: MouseEvent) => {
      const row =
        ev.target instanceof Element ? ev.target.closest<HTMLElement>(".cc-pal-item") : null;
      if (!row) return;
      const item = visible[Number(row.getAttribute("data-cc-index"))];
      if (item) {
        close();
        item.run();
      }
    });
    ctx.listen(scrim, "mousedown", () => close());

    ctx.onCleanup(() => close());
  },
};
