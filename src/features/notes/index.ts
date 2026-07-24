/**
 * Notes — Tier 2, conversation scope. A LIVE-MARKDOWN editor.
 *
 * Store shape migrated from the legacy `cc-notes3-<convId>` localStorage:
 * an array of { id, text, at, up } note records.
 *
 * BEHAVIOR:
 * - Note LIST: title from first non-empty line (markers stripped), todo
 *   progress badge N/M, creation date, hover-✕ delete, "+ New note".
 * - Note VIEW: always-editable, formats AS YOU TYPE (Obsidian-style):
 *   `# heading` renders bold with a dimmed marker, `**bold**` and `` `code` ``
 *   render inline with dimmed markers, and `- [ ]` lines become REAL inline
 *   checkboxes that flip the underlying markdown. Enter on a todo continues
 *   the list (empty todo + Enter converts to a plain line); Backspace at line
 *   start strips the todo prefix or merges into the previous line; a "+ todo"
 *   button appends a todo line; the header title updates live. A small
 *   "markdown" hint sits under the editor.
 *
 * HOST API (called by header-cluster — it owns the 📝 button + popover shell;
 * this feature never creates a header button of its own. The PANEL HEADER
 * inside the popover is OURS alone — the shell renders none, which is the
 * doubled-header fix):
 * - `mountNotesPanel(container)` — clear `container` and render the notes UI
 *   into it. Call it every time the 📝 popover opens (idempotent; re-renders).
 *   Outside a conversation it renders a quiet empty state.
 * - `notesHasContent()` — resolves true when the current conversation has at
 *   least one non-empty note (for the "auto-open when non-empty" behavior).
 *
 * PERSISTENCE: ctx.storage.conv kind "notes" holds the NoteRecord[] (the
 * runtime value deliberately supersedes core's legacy `string` typing for the
 * kind — see the documented cast at {@link persistNotes}; storage is JSON
 * either way). Imports, once per conversation:
 * - a legacy plain-string scratchpad (migrated `cc-notes-<convId>`) becomes a
 *   single note;
 * - migrated `cc-notes3-<convId>` data (which the one-time localStorage
 *   migration filed under the "todos" kind) is adopted when it is note-shaped.
 * Saves are debounced 250 ms via ctx.setTimeout (generation-token debounce —
 * managed timers can't be cleared) and FLUSHED in unmount().
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl } from "@/ui/root";

const OWNER = "notes";
const SAVE_DEBOUNCE_MS = 250;

const TODO_RE = /^- \[([x ])\] ?(.*)$/;
const TODO_LINE_RE = /^- \[[x ]\] /;
const TODO_PREFIX_RE = /^- \[[x ]\] ?/;
const HEADING_RE = /^(#{1,6}\s)([\s\S]*)$/;

export interface NoteRecord {
  id: string;
  /** Raw markdown text, lines joined with \n. */
  text: string;
  /** ISO timestamp — created. */
  at: string;
  /** ISO timestamp — last updated. */
  up: string;
}

interface MountState {
  readonly ctx: FeatureContext;
  notes: NoteRecord[];
  loaded: Promise<void>;
  loadDone: boolean;
  /** null = list view; otherwise the open note's id. */
  currentId: string | null;
  /** The open note's lines (the editing model; joined on save). */
  model: string[];
  saveGen: number;
  dirty: boolean;
  container: HTMLElement | null;
  wiredContainers: WeakSet<HTMLElement>;
}

let active: MountState | null = null;
/** Last popover body the header cluster handed us — re-rendered on remount so
 *  an open popover survives a conversation switch with fresh data. */
let lastContainer: HTMLElement | null = null;

/** The send-notes button awaiting its bridge:send-result flash. */
let notesSendPending: HTMLElement | null = null;

export const notes: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    const state: MountState = {
      ctx,
      notes: [],
      loaded: Promise.resolve(),
      loadDone: false,
      currentId: null,
      model: [""],
      saveGen: 0,
      dirty: false,
      container: null,
      wiredContainers: new WeakSet(),
    };
    state.loaded = loadNotes(state);
    active = state;
    ctx.onCleanup(() => {
      if (active === state) active = null;
    });

    // The header cluster owns the 📝 button + popover shell; it announces
    // every open on the bus with the popover body (idempotent re-mount).
    ctx.on("ui:notes-open", ({ container }) => mountNotesPanel(container));

    // Flash the send-notes button on the bridge's verdict (✓ delivered / red
    // when no session or the send failed).
    ctx.on("bridge:send-result", ({ ok }) => {
      const b = notesSendPending;
      if (!b || !b.isConnected) {
        notesSendPending = null;
        return;
      }
      notesSendPending = null;
      b.innerHTML = ok ? NOTES_SVG_OK : NOTES_SVG_SEND;
      b.classList.add(ok ? "cc-ok" : "cc-danger-text");
      ctx.setTimeout(() => {
        if (!b.isConnected) return;
        b.innerHTML = NOTES_SVG_SEND;
        b.classList.remove("cc-ok", "cc-danger-text");
      }, 1600);
    });

    // The answer-toolbar's "add to note" lands here (bus event — features
    // never import each other): the snippet becomes a NEW note for this
    // conversation. An open LIST view refreshes; an open editor is left
    // untouched (re-rendering mid-edit would drop the caret).
    ctx.on("ui:note-append", ({ text }) => {
      void state.loaded.then(() => {
        if (active !== state || ctx.signal.aborted) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        const now = new Date().toISOString();
        state.notes.push({ id: genId(), text: trimmed, at: now, up: now });
        saveNow(state);
        if (state.currentId === null && lastContainer?.isConnected) {
          mountNotesPanel(lastContainer);
        }
      });
    });

    // If the popover is open while conversations switch, refresh it in place.
    if (lastContainer?.isConnected) {
      const container = lastContainer;
      void state.loaded.then(() => {
        if (active === state && lastContainer === container && container.isConnected) {
          mountNotesPanel(container);
        }
      });
    }
  },

  unmount() {
    if (active) flushSave(active);
  },
};

// ---------------------------------------------------------------------------
// Host API (header-cluster)
// ---------------------------------------------------------------------------

/** Render the notes UI into the 📝 popover body. Safe to call on every open. */
export function mountNotesPanel(container: HTMLElement): void {
  lastContainer = container;
  const state = active;
  container.replaceChildren();
  if (!state) {
    container.append(listHead(), emptyLine("Open a conversation to take notes."));
    return;
  }
  wire(state, container);
  if (state.loadDone) {
    renderInto(state, container);
    return;
  }
  container.appendChild(emptyLine("Loading notes…"));
  void state.loaded.then(() => {
    if (active !== state || lastContainer !== container || !container.isConnected) return;
    renderInto(state, container);
  });
}

/** True when the current conversation has at least one non-empty note —
 *  the header cluster auto-opens the popover in that case. */
export async function notesHasContent(): Promise<boolean> {
  const state = active;
  if (!state) return false;
  await state.loaded;
  if (active !== state) return false;
  return state.notes.some((n) => n.text.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isNoteRecord(v: unknown): v is Partial<NoteRecord> & { id: string; text: string } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  // `done: boolean` marks a real v2 TODO item — those are NOT note records.
  return typeof o["id"] === "string" && typeof o["text"] === "string" &&
    typeof o["done"] !== "boolean";
}

function normalizeNote(v: Partial<NoteRecord> & { id: string; text: string }): NoteRecord {
  const now = new Date().toISOString();
  return {
    id: v.id,
    text: v.text,
    at: typeof v.at === "string" ? v.at : now,
    up: typeof v.up === "string" ? v.up : now,
  };
}

async function loadNotes(state: MountState): Promise<void> {
  const rawNotes = (await state.ctx.storage.conv.get("notes")) as unknown;
  let list: NoteRecord[] | null = null;
  let needsSeed = false;

  if (Array.isArray(rawNotes)) {
    list = rawNotes.filter(isNoteRecord).map(normalizeNote);
  } else if (typeof rawNotes === "string" && rawNotes.trim()) {
    // Legacy v1 scratchpad (migrated cc-notes-<convId>) → one note.
    const now = new Date().toISOString();
    list = [{ id: genId(), text: rawNotes, at: now, up: now }];
    needsSeed = true;
  }

  if (!list || list.length === 0) {
    // The one-time localStorage migration filed cc-notes3-* (the v4 note
    // store) under the "todos" kind. Adopt it when every item is note-shaped.
    const rawTodos = (await state.ctx.storage.conv.get("todos")) as unknown;
    if (Array.isArray(rawTodos) && rawTodos.length > 0 && rawTodos.every(isNoteRecord)) {
      list = rawTodos.map(normalizeNote);
      needsSeed = true;
    }
  }

  state.notes = list ?? [];
  state.loadDone = true;
  if (needsSeed && !state.ctx.signal.aborted) void persistNotes(state);
}

function persistNotes(state: MountState): Promise<void> {
  // Deliberate cast: the "notes" kind's canonical runtime value is now
  // NoteRecord[] (the v4 store). core/storage.ts still declares the legacy
  // `string` for the kind — the value is plain
  // JSON in storage.local either way, and this feature is the kind's only
  // reader/writer (loadNotes handles both shapes).
  return state.ctx.storage.conv.set("notes", state.notes as unknown as string);
}

function scheduleSave(state: MountState): void {
  state.dirty = true;
  const gen = ++state.saveGen;
  state.ctx.setTimeout(() => {
    if (active === state && gen === state.saveGen) flushSave(state);
  }, SAVE_DEBOUNCE_MS);
}

function flushSave(state: MountState): void {
  if (!state.dirty) return;
  state.dirty = false;
  void persistNotes(state);
}

function saveNow(state: MountState): void {
  state.dirty = true;
  state.saveGen++; // invalidate pending debounce
  flushSave(state);
}

// ---------------------------------------------------------------------------
// Note helpers
// ---------------------------------------------------------------------------

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function titleOf(n: NoteRecord): string {
  const line = n.text
    .split("\n")
    .map((s) => s.replace(/^#+\s*|- \[[x ]\]\s*|\*\*/g, "").trim())
    .find((s) => s.length > 0);
  return line ?? "(empty note)";
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

function applyModelToNote(state: MountState): void {
  const note = state.notes.find((n) => n.id === state.currentId);
  if (!note) return;
  note.text = state.model.join("\n");
  note.up = new Date().toISOString();
  scheduleSave(state);
  updateTitleEl(state);
}

function todoCounts(text: string): { done: number; total: number } {
  const total = (text.match(/- \[[x ]\]/g) ?? []).length;
  const done = (text.match(/- \[x\]/g) ?? []).length;
  return { done, total };
}

function updateTitleEl(state: MountState): void {
  const note = state.notes.find((n) => n.id === state.currentId);
  if (!note) return;
  const el = state.container?.querySelector<HTMLElement>(".cc-notes-cur-title");
  if (el) el.textContent = titleOf(note);
  const chip = state.container?.querySelector<HTMLElement>(".cc-note-chip");
  if (chip) {
    const { done, total } = todoCounts(note.text);
    chip.textContent = `${done}/${total}`;
    chip.classList.toggle("cc-hidden", total === 0);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function emptyLine(text: string): HTMLElement {
  return ownedEl("div", { owner: OWNER, className: "cc-notes-empty", text });
}

function renderInto(
  state: MountState,
  container: HTMLElement,
  focus?: { line: number; off: number },
): void {
  state.container = container;
  container.replaceChildren();
  if (state.currentId === null) {
    renderList(state, container);
    return;
  }
  const note = state.notes.find((n) => n.id === state.currentId);
  if (!note) {
    state.currentId = null;
    renderList(state, container);
    return;
  }
  renderEditor(state, container, note, focus);
}

/** Same paper-plane as the answer-toolbar / outline "Send to Claude Code". */
const NOTES_SVG_SEND =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>';
const NOTES_SVG_OK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

/** The send-all-notes icon button (list + editor headers share it). */
function sendNotesBtn(): HTMLElement {
  const b = ownedEl("button", {
    owner: OWNER,
    className: "cc-iconbtn cc-note-send",
    attrs: { type: "button", title: "Send this chat's notes to Claude Code" },
  });
  b.innerHTML = NOTES_SVG_SEND;
  return b;
}

/** All notes of this chat as one export markdown (handoff body). */
function notesMarkdown(state: MountState): string {
  const title = state.ctx.conversation.current()?.name ?? "(untitled)";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const n = state.notes.length;
  let md = `# Notes — ${title}\n\n_${n} note${n === 1 ? "" : "s"} · exported ${stamp}_\n\n`;
  state.notes.forEach((note, i) => {
    md += `## Note ${i + 1}\n\n${note.text.trim() || "(empty note)"}\n\n`;
  });
  return md.trimEnd() + "\n";
}

/** The panel's ONE header (list view + empty states) — the header-cluster
 *  popover shell deliberately renders none (doubled-header fix). */
function listHead(): HTMLElement {
  const head = ownedEl("div", { owner: OWNER, className: "cc-notes-head" });
  head.appendChild(ownedEl("span", { owner: OWNER, className: "cc-notes-title", text: "Notes" }));
  head.appendChild(
    ownedEl("span", { owner: OWNER, className: "cc-notes-scope", text: "this chat · markdown" }),
  );
  head.appendChild(sendNotesBtn());
  return head;
}

/** Terminal-style block meter (▓▓▓░░ 3/5) echoing the status bar's gauge:
 *  done blocks in --cc-ok green, the progress tip in accent while open todos
 *  remain, faint ░ for the rest. Width caps at 8 blocks for long lists. */
function todoMeterEl(done: number, total: number): HTMLElement {
  const meter = ownedEl("span", { owner: OWNER, className: "cc-note-meter" });
  const width = Math.min(total, 8);
  let filled = Math.round((done / total) * width);
  if (done > 0 && filled === 0) filled = 1;
  if (done < total && filled === width) filled = width - 1;
  // Coral progress tip on the leading filled block — only while open todos
  // remain, and only past the first done item.
  const tip = done > 1 && done < total ? 1 : 0;
  if (filled - tip > 0) {
    meter.appendChild(
      ownedEl("span", {
        owner: OWNER,
        className: "cc-meter-f",
        text: "▓".repeat(filled - tip),
      }),
    );
  }
  if (tip > 0) {
    meter.appendChild(ownedEl("span", { owner: OWNER, className: "cc-meter-p", text: "▓" }));
  }
  meter.append(`${"░".repeat(width - filled)} ${done}/${total}`);
  return meter;
}

function renderList(state: MountState, container: HTMLElement): void {
  container.appendChild(listHead());

  const newBtn = ownedEl("button", {
    owner: OWNER,
    className: "cc-note-new",
    attrs: { type: "button" },
  });
  newBtn.append(
    ownedEl("span", { owner: OWNER, className: "cc-note-new-plus", text: "+" }),
    "New note",
  );
  container.appendChild(newBtn);

  const list = ownedEl("div", { owner: OWNER, className: "cc-notes-list" });
  if (state.notes.length === 0) {
    list.appendChild(emptyLine("No notes yet for this chat."));
  }
  for (const n of [...state.notes].reverse()) {
    const { done, total } = todoCounts(n.text);
    const hasOpen = total > 0 && done < total;
    const row = ownedEl("div", {
      owner: OWNER,
      className: "cc-note-row" + (hasOpen ? " cc-has-todo" : ""),
    });
    row.dataset["id"] = n.id;

    row.appendChild(
      ownedEl("span", { owner: OWNER, className: "cc-note-row-title", text: titleOf(n) }),
    );

    const meta = ownedEl("div", { owner: OWNER, className: "cc-note-meta" });
    meta.appendChild(ownedEl("span", { owner: OWNER, text: fmtDate(n.at) }));
    if (total > 0) meta.appendChild(todoMeterEl(done, total));
    row.appendChild(meta);

    const del = ownedEl("button", {
      owner: OWNER,
      className: "cc-note-del",
      text: "✕",
      attrs: { type: "button", title: "Delete note", "aria-label": "Delete note" },
    });
    del.dataset["id"] = n.id;
    row.appendChild(del);

    list.appendChild(row);
  }
  container.appendChild(list);
}

function renderEditor(
  state: MountState,
  container: HTMLElement,
  note: NoteRecord,
  focus?: { line: number; off: number },
): void {
  const head = ownedEl("div", { owner: OWNER, className: "cc-notes-head" });
  head.appendChild(
    ownedEl("button", {
      owner: OWNER,
      className: "cc-note-back",
      text: "‹",
      attrs: { type: "button", "aria-label": "Back to notes list", title: "Back" },
    }),
  );
  head.appendChild(
    ownedEl("span", {
      owner: OWNER,
      className: "cc-notes-title cc-notes-cur-title",
      text: titleOf(note),
    }),
  );
  const { done, total } = todoCounts(note.text);
  head.appendChild(
    ownedEl("span", {
      owner: OWNER,
      className: "cc-note-chip" + (total === 0 ? " cc-hidden" : ""),
      text: `${done}/${total}`,
    }),
  );
  head.appendChild(
    ownedEl("button", {
      owner: OWNER,
      className: "cc-note-addtodo",
      text: "+ todo",
      attrs: { type: "button", "aria-label": "Add a todo line" },
    }),
  );
  head.appendChild(sendNotesBtn());
  container.appendChild(head);

  const ed = ownedEl("div", { owner: OWNER, className: "cc-note-ed" });
  if (state.model.length === 0) state.model = [""];
  state.model.forEach((line, i) => ed.appendChild(buildLine(line, i)));
  container.appendChild(ed);

  const hint = ownedEl("div", { owner: OWNER, className: "cc-note-hint" });
  const hintTokens = ["# heading", "**bold**", "`code`", "- [ ] todo"];
  hintTokens.forEach((tok, idx) => {
    if (idx > 0) hint.append(" · ");
    hint.appendChild(ownedEl("span", { owner: OWNER, className: "cc-hint-k", text: tok }));
  });
  container.appendChild(hint);

  if (focus) focusLine(container, focus.line, focus.off);
}

function buildLine(line: string, i: number): HTMLElement {
  const row = ownedEl("div", { owner: OWNER, className: "cc-note-line" });
  row.dataset["i"] = String(i);

  const span = ownedEl("div", { owner: OWNER, className: "cc-note-text" });
  span.contentEditable = "true";
  span.dataset["i"] = String(i);

  const todo = TODO_RE.exec(line);
  if (todo) {
    const mark = todo[1] ?? " ";
    const done = mark === "x";
    const cb = ownedEl("button", {
      owner: OWNER,
      className: "cc-note-cb" + (done ? " cc-done" : ""),
      text: done ? "✓" : "",
      attrs: {
        type: "button",
        "aria-label": done ? "Mark todo as not done" : "Mark todo as done",
      },
    });
    cb.contentEditable = "false";
    cb.dataset["i"] = String(i);
    row.appendChild(cb);
    if (done) row.classList.add("cc-done");
    span.dataset["prefix"] = `- [${mark}] `;
    appendInline(span, todo[2] ?? "");
  } else {
    span.dataset["prefix"] = "";
    fillNonTodo(span, line);
  }

  row.appendChild(span);
  return row;
}

/** Rebuild a plain / heading line's children from its raw text. */
function fillNonTodo(span: HTMLElement, line: string): void {
  span.replaceChildren();
  const head = HEADING_RE.exec(line);
  if (head) {
    span.classList.add("cc-h");
    span.appendChild(markerEl(head[1] ?? ""));
    appendInline(span, head[2] ?? "");
  } else {
    span.classList.remove("cc-h");
    appendInline(span, line);
  }
}

/** Re-render one line's inline formatting in place (live-typing path). */
function rebuildSpan(span: HTMLElement, rawLine: string): void {
  const prefix = span.dataset["prefix"] ?? "";
  if (prefix) {
    span.replaceChildren();
    appendInline(span, rawLine.slice(prefix.length));
  } else {
    fillNonTodo(span, rawLine);
  }
}

/** Live inline markdown: `**bold**` and `` `code` `` with dimmed markers.
 *  Markers stay in the DOM as literal text so `textContent` round-trips to
 *  the raw markdown line (the editing model depends on that). */
function appendInline(parent: HTMLElement, text: string): void {
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parent.append(markerEl("**"));
      parent.append(ownedEl("b", { owner: OWNER, className: "cc-md-b", text: tok.slice(2, -2) }));
      parent.append(markerEl("**"));
    } else {
      parent.append(markerEl("`"));
      parent.append(
        ownedEl("code", { owner: OWNER, className: "cc-md-code", text: tok.slice(1, -1) }),
      );
      parent.append(markerEl("`"));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function markerEl(text: string): HTMLElement {
  return ownedEl("span", { owner: OWNER, className: "cc-md-marker", text });
}

// ---------------------------------------------------------------------------
// Caret helpers (offset within a line span's textContent)
// ---------------------------------------------------------------------------

function caretOffset(span: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const anchor = sel.anchorNode;
  if (!anchor || !span.contains(anchor)) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(span);
  r.setEnd(anchor, sel.anchorOffset);
  return r.toString().length;
}

function setCaret(span: HTMLElement, off: number): void {
  span.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let node: Text | null = null;
  let rem = off;
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    const len = t.textContent?.length ?? 0;
    if (rem <= len) {
      node = t;
      break;
    }
    rem -= len;
  }
  if (!node) {
    range.selectNodeContents(span);
    range.collapse(false);
  } else {
    range.setStart(node, rem);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

function focusLine(container: HTMLElement, i: number, off: number | "end"): void {
  const spans = container.querySelectorAll<HTMLElement>(".cc-note-text");
  const span = spans[Math.min(i, spans.length - 1)];
  if (!span) return;
  const len = (span.textContent ?? "").length;
  setCaret(span, off === "end" ? len : Math.min(off, len));
}

// ---------------------------------------------------------------------------
// Delegated events (one listener set per container per conversation mount —
// re-renders never accumulate handlers in the managed ledger)
// ---------------------------------------------------------------------------

function wire(state: MountState, container: HTMLElement): void {
  if (state.wiredContainers.has(container)) return;
  state.wiredContainers.add(container);
  state.ctx.listen(container, "click", (ev: MouseEvent) => onClick(state, container, ev));
  state.ctx.listen(container, "input", (ev: Event) => onInput(state, container, ev));
  state.ctx.listen(container, "keydown", (ev: KeyboardEvent) => onKeydown(state, container, ev));
}

function onClick(state: MountState, container: HTMLElement, ev: MouseEvent): void {
  const t = ev.target instanceof HTMLElement ? ev.target : null;
  if (!t) return;

  const send = t.closest<HTMLElement>(".cc-note-send");
  if (send) {
    flushSave(state); // include the note being edited right now
    notesSendPending = send;
    state.ctx.bus.emit("bridge:send", {
      handle: "context",
      scope: "notes",
      body: notesMarkdown(state),
    });
    return;
  }

  const del = t.closest<HTMLElement>(".cc-note-del");
  if (del) {
    const id = del.dataset["id"];
    if (id) {
      state.notes = state.notes.filter((n) => n.id !== id);
      saveNow(state);
      renderInto(state, container);
    }
    return;
  }

  const cb = t.closest<HTMLElement>(".cc-note-cb");
  if (cb) {
    const i = Number(cb.dataset["i"]);
    const line = state.model[i];
    if (line !== undefined) {
      state.model[i] = line.startsWith("- [x]")
        ? line.replace("- [x]", "- [ ]")
        : line.replace("- [ ]", "- [x]");
      applyModelToNote(state);
      saveNow(state);
      renderInto(state, container);
    }
    return;
  }

  if (t.closest(".cc-note-back")) {
    flushSave(state);
    state.currentId = null;
    renderInto(state, container);
    return;
  }

  if (t.closest(".cc-note-addtodo")) {
    if (state.currentId === null) return;
    state.model.push("- [ ] ");
    applyModelToNote(state);
    renderInto(state, container, { line: state.model.length - 1, off: 0 });
    return;
  }

  if (t.closest(".cc-note-new")) {
    const now = new Date().toISOString();
    const note: NoteRecord = { id: genId(), text: "", at: now, up: now };
    state.notes.push(note);
    saveNow(state);
    openNote(state, container, note.id);
    return;
  }

  const row = t.closest<HTMLElement>(".cc-note-row");
  if (row) {
    const id = row.dataset["id"];
    if (id) openNote(state, container, id);
    return;
  }

  // Click on the editor's empty space → caret to the end of the last line.
  if (t.classList.contains("cc-note-ed")) {
    focusLine(container, state.model.length - 1, "end");
  }
}

function openNote(state: MountState, container: HTMLElement, id: string): void {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  state.currentId = id;
  state.model = note.text ? note.text.split("\n") : [""];
  renderInto(state, container);
}

function onInput(state: MountState, container: HTMLElement, ev: Event): void {
  const t = ev.target instanceof HTMLElement ? ev.target : null;
  const span = t?.closest<HTMLElement>(".cc-note-text");
  if (!span || state.currentId === null) return;
  const i = Number(span.dataset["i"]);
  if (!Number.isInteger(i) || i < 0 || i >= state.model.length) return;

  const off = caretOffset(span);
  const prefix = span.dataset["prefix"] ?? "";
  const text = span.textContent ?? "";
  state.model[i] = prefix + text;

  // A plain line typed into a todo pattern → structural convert (checkbox).
  if (!prefix && TODO_LINE_RE.test(text)) {
    applyModelToNote(state);
    renderInto(state, container, { line: i, off: 0 });
    return;
  }

  rebuildSpan(span, state.model[i] ?? "");
  if (off !== null) setCaret(span, Math.min(off, (span.textContent ?? "").length));
  applyModelToNote(state);
}

function onKeydown(state: MountState, container: HTMLElement, ev: KeyboardEvent): void {
  const t = ev.target instanceof HTMLElement ? ev.target : null;
  const span = t?.closest<HTMLElement>(".cc-note-text");
  if (!span || state.currentId === null) return;
  // Keep editor keystrokes away from claude.ai's global shortcuts.
  ev.stopPropagation();

  const i = Number(span.dataset["i"]);
  if (!Number.isInteger(i) || i < 0 || i >= state.model.length) return;
  const prefix = span.dataset["prefix"] ?? "";
  const text = span.textContent ?? "";

  if (ev.key === "Enter") {
    ev.preventDefault();
    const off = caretOffset(span) ?? 0;
    const before = text.slice(0, off);
    const after = text.slice(off);
    const isTodo = prefix !== "";
    if (isTodo && !text.trim()) {
      // Enter on an empty todo → convert to a plain empty line.
      state.model[i] = "";
      applyModelToNote(state);
      renderInto(state, container, { line: i, off: 0 });
      return;
    }
    state.model[i] = prefix + before;
    state.model.splice(i + 1, 0, (isTodo ? "- [ ] " : "") + after);
    applyModelToNote(state);
    renderInto(state, container, { line: i + 1, off: 0 });
    return;
  }

  if (ev.key === "Backspace") {
    if (caretOffset(span) !== 0) return;
    ev.preventDefault();
    if (prefix) {
      // Strip the todo prefix, keep the text.
      state.model[i] = text;
      applyModelToNote(state);
      renderInto(state, container, { line: i, off: 0 });
      return;
    }
    if (i > 0) {
      const prev = state.model[i - 1] ?? "";
      const prevLen = prev.replace(TODO_PREFIX_RE, "").length;
      state.model[i - 1] = prev + text;
      state.model.splice(i, 1);
      applyModelToNote(state);
      renderInto(state, container, { line: i - 1, off: prevLen });
    }
    return;
  }

  if (ev.key === "ArrowUp" && i > 0) {
    if (caretOffset(span) === 0) {
      ev.preventDefault();
      focusLine(container, i - 1, "end");
    }
    return;
  }

  if (ev.key === "ArrowDown" && i < state.model.length - 1) {
    if (caretOffset(span) === text.length) {
      ev.preventDefault();
      focusLine(container, i + 1, 0);
    }
  }
}
