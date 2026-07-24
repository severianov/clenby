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
 * A second MODE, "shortcuts", reuses this same panel/scrim/input/filter as the
 * product's keyboard reference (@/shared/keymap is the single source). Entered
 * from the Actions row or the gear menu's Keyboard-shortcuts row (bus
 * "ui:palette-shortcuts"); Esc backs out to the command list, a second Esc
 * closes — the unwind idiom atlas and selector-health already use.
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
import { kbdSet, kbdDefinition } from "@/ui/kbd";
import {
  KEY_SCOPES,
  KEYMAP_FOOTNOTE,
  SHORTCUT_LIST,
  chordOf,
  chordSpoken,
  chordText,
  type Chord,
} from "@/shared/keymap";

const OWNER = "command-palette";

const MAX_PER_GROUP = 12;
const CONVERSATIONS_FETCH_LIMIT = 100;
const UNDO_ENABLE_SECONDS = 5;

type Group = "Actions" | "This chat" | "Chats";
const GROUP_ORDER: readonly Group[] = ["Actions", "This chat", "Chats"];

type PaletteMode = "commands" | "shortcuts";

interface PaletteItem {
  group: Group;
  label: string;
  /** Faint right-aligned hint (e.g. "#12", "2h ago"). Ignored when `chord`
   *  is set — the key chips take that slot. */
  hint: string;
  /** The keystroke that runs this item, when it has one. */
  chord?: Chord;
  /** Items that re-render the panel instead of dismissing it. */
  keepOpen?: true;
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
    // A SIBLING container, not a role swap on `list` — AT caches container
    // roles inconsistently, and paintActive/mousemove/click all query
    // `.cc-pal-item` against `list`.
    const refList = ownedEl("div", {
      owner: OWNER,
      className: "cc-pal-ref-list cc-hidden",
      attrs: { role: "list" },
    });
    // One-line mono legend. Decorative: every key it names is also on a
    // control's own label.
    const foot = ownedEl("div", {
      owner: OWNER,
      className: "cc-pal-foot",
      attrs: { "aria-hidden": "true" },
    });
    panel.append(input, list, refList, foot);
    ctx.root.append(scrim, panel);

    // ---- state ---------------------------------------------------------------
    let open = false;
    let mode: PaletteMode = "commands";
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
          label: "Keyboard shortcuts — every key Clenby binds",
          hint: "help",
          keepOpen: true,
          run: () => setMode("shortcuts"),
        },
        {
          group: "Actions",
          label: "Find in conversation — search every message",
          hint: "action",
          chord: chordOf("find"),
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
          label: `Toggle Enter behavior — Enter for newline, ${chordText(
            chordOf("enterSend"),
          )} to send`,
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
        const haystack = item.chord
          ? `${item.label} ${chordText(item.chord)} ${chordSpoken(item.chord)}`
          : item.label;
        const score = fuzzyScore(query, haystack);
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
            attrs: {
              role: "option",
              "data-cc-index": String(i),
              // Chips are aria-hidden — name the row instead.
              ...(item.chord ? { "aria-label": `${item.label}. ${chordSpoken(item.chord)}` } : {}),
            },
          });
          row.append(
            ownedEl("span", { owner: OWNER, className: "cc-pal-label", text: item.label }),
            item.chord
              ? kbdSet(OWNER, item.chord)
              : ownedEl("span", { owner: OWNER, className: "cc-pal-hint", text: item.hint }),
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

    /**
     * The shortcuts reference — a description list, not a command list:
     * <dt> is what it does, <dd> is the keys. Rows are not runnable, so they
     * are not options and ↑/↓ scroll instead of selecting. Filtered by the
     * same fuzzyScore over action + note + printed chord.
     */
    const renderReference = (): void => {
      const query = input.value.trim();
      refList.replaceChildren();
      let shown = 0;
      for (const scope of KEY_SCOPES) {
        const rows = SHORTCUT_LIST.filter(
          (s) =>
            s.scope === scope &&
            fuzzyScore(query, `${s.action} ${s.note ?? ""} ${chordText(s.chord)}`) !== null,
        );
        if (rows.length === 0) continue;
        refList.appendChild(
          ownedEl("div", { owner: OWNER, className: "cc-pal-group", text: scope }),
        );
        // Group headings sit OUTSIDE the <dl> — a heading may not live in one.
        const dl = ownedEl("dl", { owner: OWNER, className: "cc-pal-ref-dl" });
        for (const s of rows) {
          shown++;
          const dt = ownedEl("dt", { owner: OWNER, className: "cc-pal-ref-tx" });
          dt.appendChild(
            ownedEl("div", { owner: OWNER, className: "cc-pal-ref-act", text: s.action }),
          );
          if (s.note) {
            dt.appendChild(
              ownedEl("div", { owner: OWNER, className: "cc-pal-ref-note", text: s.note }),
            );
          }
          dl.append(dt, kbdDefinition(OWNER, s.chord));
        }
        refList.appendChild(dl);
      }
      if (shown === 0) {
        refList.appendChild(
          ownedEl("div", { owner: OWNER, className: "cc-pal-empty", text: "No matches" }),
        );
      }
      // Standing footnote, NOT .cc-pal-empty (that class means "no results"
      // and would read as a bug beside real rows).
      refList.appendChild(
        ownedEl("div", { owner: OWNER, className: "cc-pal-ref-foot", text: KEYMAP_FOOTNOTE }),
      );
    };

    const paint = (): void => {
      if (mode === "shortcuts") renderReference();
      else render();
    };

    const legendPart = (chord: Chord, text: string): Node[] => [
      kbdSet(OWNER, chord),
      ownedEl("span", { owner: OWNER, text }),
    ];
    const legendDot = (): HTMLSpanElement => ownedEl("span", { owner: OWNER, text: "·" });
    const paintFoot = (): void => {
      foot.replaceChildren(
        ...(mode === "shortcuts"
          ? [
              ...legendPart({ keys: ["↑", "↓"] }, "scroll"),
              legendDot(),
              ...legendPart({ keys: ["Esc"] }, "back"),
            ]
          : [
              // The opener LEADS — scanning stops at the first token, and it
              // is the one thing a click-discovered user needs.
              ...legendPart(chordOf("palette"), "opens this anywhere"),
              legendDot(),
              ...legendPart({ keys: ["↑", "↓"] }, "move"),
              legendDot(),
              ...legendPart({ keys: ["Enter"] }, "run"),
              legendDot(),
              ...legendPart({ keys: ["Esc"] }, "close"),
            ]),
      );
    };

    /** Mode → panel chrome only (which list shows, what the input says). No
     *  render, no focus — safe to call on a hidden panel. */
    const applyMode = (): void => {
      const ref = mode === "shortcuts";
      input.placeholder = ref ? "Filter shortcuts…" : "Jump to a chat or message, run an action…";
      input.setAttribute("aria-label", ref ? "Filter shortcuts" : "Command palette search");
      list.classList.toggle("cc-hidden", ref);
      refList.classList.toggle("cc-hidden", !ref);
    };

    const setMode = (next: PaletteMode): void => {
      mode = next;
      input.value = "";
      activeIndex = 0;
      applyMode();
      paintFoot();
      paint();
    };

    paintFoot(); // built once at mount

    // ---- open / close -----------------------------------------------------------
    const close = (): void => {
      if (!open) return;
      open = false;
      openToken++;
      scrim.classList.add("cc-hidden");
      panel.classList.add("cc-hidden");
      input.value = "";
      mode = "commands";
      applyMode();
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
        // Items are still updated; the reference is never repainted under the
        // reader. setMode("commands") re-renders on the way back.
        if (mode === "commands") render();
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
          if (mode === "commands") render();
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
    // The gear's Keyboard-shortcuts row: force the panel OPEN and land on the
    // reference — never toggle it shut.
    ctx.on("ui:palette-shortcuts", () => {
      if (!open) openPalette();
      setMode("shortcuts");
      input.focus();
    });

    // ---- interaction ----------------------------------------------------------
    ctx.listen(input, "input", () => {
      activeIndex = 0;
      paint();
    });

    ctx.listen(input, "keydown", (ev: KeyboardEvent) => {
      if (mode === "shortcuts") {
        // Reference rows aren't runnable, so arrows scroll. Esc unwinds ONE
        // level (atlas: deselect→close; selector-health: dialog→editor→panel).
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          refList.scrollBy({ top: ev.key === "ArrowDown" ? 56 : -56 });
        } else if (ev.key === "Escape") {
          ev.preventDefault();
          setMode("commands");
          input.focus();
        }
        return;
      }
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
          if (item.keepOpen !== true) close();
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
        if (item.keepOpen !== true) close();
        item.run();
      }
    });
    ctx.listen(scrim, "mousedown", () => close());

    ctx.onCleanup(() => close());
  },
};
