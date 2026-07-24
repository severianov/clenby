/**
 * Copy / download / send for Claude Code — Tier 2, conversation scope.
 *
 * Markdown builder with an inline scope chooser and artifact-placeholder
 * cleanup.
 *
 * BEHAVIOR:
 * - Three menu rows — "Copy conversation" (⧉), "Download handoff.md" (⬇), and
 *   "Send to Claude Code" (✈) — each an icon + label + detail line. Clicking a
 *   row expands an inline SCOPE chooser: "Everything — you + Claude" / "Only
 *   Claude's answers" (the Send row lists answers first — the common case).
 *   Copy/download run the action and flash a green ✓ + status in the detail
 *   line for 1.8 s; Send emits the shared "bridge:send" bus contract and flashes
 *   on the "bridge:send-result" reply. The Send row is INERT (greyed, no
 *   expansion) until ≥1 Claude Code session connects (spec §3).
 * - Markdown format: `# Claude web chat handoff — <name>` header, meta line,
 *   then `## You` / `## Claude` sections. Code fences stay intact; artifact
 *   placeholder fences ("This block is not supported…") are replaced with
 *   `*[artifact / code block omitted — open in claude.ai]*`. Attachment-only
 *   messages keep their `📎 N attachments` labels (the conversation store
 *   supplies them).
 * - Serialized from the API-backed conversation index (ctx.conversation) —
 *   NEVER the DOM (virtualization renders only 2–4 messages).
 *
 * HOST API (called by header-cluster's gear menu — it owns the menu shell and
 * its "Export" section; this feature creates no top-level UI of its own):
 * - `mountExportRows(container)` — clear `container` and render the rows into
 *   it. Call it whenever the gear menu (re)opens. Outside a conversation it
 *   renders a quiet empty state.
 * - `getHandoffMarkdown(scope)` — the serialized markdown for programmatic
 *   hosts (e.g. a plain "Copy for Claude Code" menu row), or null when no
 *   conversation index is available.
 *
 * Download object URLs are revoked after 5 s and, as a safety net, at
 * unmount via ctx.onCleanup.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { buildHandoffMarkdown } from "@/shared/handoff";
import { ownedEl } from "@/ui/root";

// The conversation-body serializer lives in shared/handoff.ts (the single
// source of truth the Claude Code bridge also uses — a feature never imports
// another feature). Re-exported here for existing callers/tests.
export { buildHandoffMarkdown };

const OWNER = "export";
export type ExportScope = "all" | "claude";
type ExportAction = "copy" | "download" | "send";

const DEFAULT_DETAIL = "choose what to include →";
/** Send-row detail line while no Claude Code session is connected (spec §3);
 *  the row stays inert until ≥1 session lights it up. */
const SEND_INERT_LABEL = "Start Claude Code and this lights up.";
const FLASH_MS = 1800;
/** How long the shared cc-sent-pulse success animation class stays applied — a
 *  touch past its 250ms CSS animation, then cleared by a managed timer. */
const PULSE_MS = 320;
const URL_REVOKE_MS = 5000;

// Lucide-style line icons (stroke: currentColor — colored by CSS classes).
const ICON_COPY =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_DOWNLOAD =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
const ICON_CHECK =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
/** Same paper-plane the answer-toolbar / outline send surfaces use (spec §3),
 *  sized to this section's 15px icons. Static constant — never interpolated. */
const ICON_SEND =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>';

interface ExportState {
  readonly ctx: FeatureContext;
  readonly pendingUrls: Set<string>;
  /** ≥1 Claude Code session connected (bus-fed). The Send row is inert until
   *  this flips true (spec §3). */
  bridgeLive: boolean;
  /** The Send row awaiting its "bridge:send-result" flash, plus the
   *  correlation token that send carried. PER-MOUNT (on state, not module) so a
   *  prior conversation's in-flight send can never flash this mount's row; the
   *  reqId additionally rejects another surface's result. */
  sendPending: { item: HTMLElement; reqId: string } | null;
}

let active: ExportState | null = null;
/** Last gear-menu section body we rendered into — refreshed on remount so an
 *  open menu survives a conversation switch with fresh state. */
let lastContainer: HTMLElement | null = null;
let flashGen = 0;

export const exportFeature: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    const state: ExportState = { ctx, pendingUrls: new Set(), bridgeLive: false, sendPending: null };
    active = state;
    ctx.onCleanup(() => {
      for (const url of state.pendingUrls) URL.revokeObjectURL(url);
      state.pendingUrls.clear();
      state.sendPending = null;
      if (active === state) active = null;
    });

    // The header cluster owns the gear menu shell; it announces every open
    // on the bus with the `#cc-gear-export-slot` body (idempotent re-mount).
    ctx.on("ui:export-open", ({ container }) => mountExportRows(container));

    // Claude Code bridge liveness (the claude-code-bridge feature is the ONE
    // producer): the Send row is inert until ≥1 session connects. Repaint just
    // that row when the panel is open — features never import each other.
    ctx.on("bridge:changed", ({ sessions }) => {
      state.bridgeLive = sessions.length > 0;
      if (!lastContainer?.isConnected) return;
      const item = lastContainer.querySelector<HTMLElement>('.cc-export-item[data-action="send"]');
      if (item) syncSendRow(item);
    });

    // The bridge answers every "bridge:send" with a result — flash the pending
    // Send row's ✓ / its failure reason, but ONLY the result whose reqId echoes
    // this row's send (four surfaces share the contract; a mismatch is another
    // feature's result, an in-flight send we don't own).
    ctx.on("bridge:send-result", ({ ok, reason, reqId }) => {
      const pending = state.sendPending;
      if (!pending || reqId !== pending.reqId) return;
      state.sendPending = null;
      if (!pending.item.isConnected) return;
      flash(state, pending.item, ok ? "sent to Claude Code ✓" : reason ?? "nothing sent", ok);
      if (ok) pulseSent(state, pending.item); // shared success animation, alongside the ✓
    });

    if (lastContainer?.isConnected) mountExportRows(lastContainer);
  },
};

// ---------------------------------------------------------------------------
// Host API (header-cluster / gear menu)
// ---------------------------------------------------------------------------

/** Render the export rows into the gear menu's Export section body.
 *  Safe to call on every menu open. */
export function mountExportRows(container: HTMLElement): void {
  lastContainer = container;
  container.replaceChildren();
  const state = active;
  const rows = ownedEl("div", { owner: OWNER, className: "cc-export-rows" });
  container.appendChild(rows);

  if (!state) {
    rows.appendChild(
      ownedEl("div", {
        owner: OWNER,
        className: "cc-export-empty",
        text: "Open a conversation to export it.",
      }),
    );
    return;
  }

  rows.appendChild(buildRow(ICON_COPY, "Copy conversation", "copy"));
  rows.appendChild(buildRow(ICON_DOWNLOAD, "Download handoff.md", "download"));
  const sendItem = buildRow(ICON_SEND, "Send to Claude Code", "send");
  rows.appendChild(sendItem);
  syncSendRow(sendItem); // inert/live face for the current bridge state
  state.ctx.listen(rows, "click", (ev: MouseEvent) => onClick(state, rows, ev));
}

/** Serialized handoff markdown for the current conversation, or null when no
 *  index is available (no conversation / fetch failed with empty DOM). */
export async function getHandoffMarkdown(scope: ExportScope): Promise<string | null> {
  const state = active;
  if (!state) return null;
  return currentMarkdown(state, scope);
}

// ---------------------------------------------------------------------------
// Serializer (pure — defined in shared/handoff.ts, re-exported above)
// ---------------------------------------------------------------------------

async function currentMarkdown(state: ExportState, scope: ExportScope): Promise<string | null> {
  const index = state.ctx.conversation.current() ?? (await state.ctx.conversation.ensure());
  if (!index) return null;
  return buildHandoffMarkdown(index, scope);
}

// ---------------------------------------------------------------------------
// Rows UI
// ---------------------------------------------------------------------------

function buildRow(iconSvg: string, label: string, action: ExportAction): HTMLElement {
  const item = ownedEl("div", { owner: OWNER, className: "cc-export-item" });
  item.dataset["action"] = action;

  const row = ownedEl("div", {
    owner: OWNER,
    className: "cc-export-row",
    attrs: { role: "button", tabindex: "0", "aria-label": label },
  });
  const ic = ownedEl("span", { owner: OWNER, className: "cc-export-ic" });
  ic.innerHTML = iconSvg; // static, trusted markup (bundled icon constants)
  const tx = ownedEl("div", { owner: OWNER, className: "cc-export-tx" });
  tx.appendChild(ownedEl("div", { owner: OWNER, className: "cc-export-l1", text: label }));
  tx.appendChild(
    ownedEl("div", { owner: OWNER, className: "cc-export-l2", text: DEFAULT_DETAIL }),
  );
  row.appendChild(ic);
  row.appendChild(tx);

  const sub = ownedEl("div", { owner: OWNER, className: "cc-export-sub" });
  if (action === "send") {
    // Owner: answers first — "no one usually sends the whole chat".
    sub.appendChild(buildOpt("Only Claude’s answers", "claude", action));
    sub.appendChild(buildOpt("Everything — you + Claude", "all", action));
  } else {
    sub.appendChild(buildOpt("Everything — you + Claude", "all", action));
    sub.appendChild(buildOpt("Only Claude’s answers", "claude", action));
  }

  item.appendChild(row);
  item.appendChild(sub);
  return item;
}

/** The Send row's resting detail line: the inert hint when no bridge is
 *  connected, else the normal prompt. Every other row always rests on the
 *  default (so the flash restore below stays byte-identical for copy/download). */
function restingDetail(item: HTMLElement): string {
  return item.dataset["action"] === "send" && !(active?.bridgeLive ?? false)
    ? SEND_INERT_LABEL
    : DEFAULT_DETAIL;
}

/** Paint the Send row's inert/live face: grey it + swap its hint when no
 *  session is connected. An in-flight flash message is left untouched — the
 *  flash owns the line until it restores via restingDetail(). */
function syncSendRow(item: HTMLElement): void {
  const row = item.querySelector<HTMLElement>(".cc-export-row");
  const l2 = item.querySelector<HTMLElement>(".cc-export-l2");
  if (!row || !l2) return;
  row.classList.toggle("cc-send-inert", !(active?.bridgeLive ?? false));
  // An in-flight "Sending…" (aria-busy) owns the detail line too — leave it be.
  const flashing =
    row.getAttribute("aria-busy") === "true" ||
    l2.classList.contains("cc-ok-text") ||
    l2.classList.contains("cc-danger-text");
  if (!flashing) l2.textContent = restingDetail(item);
}

function buildOpt(label: string, scope: ExportScope, action: ExportAction): HTMLElement {
  const opt = ownedEl("div", {
    owner: OWNER,
    className: "cc-export-opt",
    text: label,
    attrs: { role: "button", tabindex: "0" },
  });
  opt.dataset["scope"] = scope;
  opt.dataset["action"] = action;
  return opt;
}

function onClick(state: ExportState, rows: HTMLElement, ev: MouseEvent): void {
  const t = ev.target instanceof HTMLElement ? ev.target : null;
  if (!t) return;

  const opt = t.closest<HTMLElement>(".cc-export-opt");
  if (opt) {
    ev.stopPropagation();
    const scope: ExportScope = opt.dataset["scope"] === "claude" ? "claude" : "all";
    const raw = opt.dataset["action"];
    const action: ExportAction = raw === "download" || raw === "send" ? raw : "copy";
    const item = opt.closest<HTMLElement>(".cc-export-item");
    if (!item) return;
    item.querySelector(".cc-export-sub")?.classList.remove("cc-open");
    void runAction(state, item, action, scope);
    return;
  }

  const row = t.closest<HTMLElement>(".cc-export-row");
  if (row) {
    // Inert Send row (no bridge connected): a click must NOT expand the
    // sub-options — the row is dormant until a session lights it up (spec §3).
    if (row.classList.contains("cc-send-inert")) return;
    const item = row.closest<HTMLElement>(".cc-export-item");
    const sub = item?.querySelector<HTMLElement>(".cc-export-sub");
    if (!sub) return;
    const willOpen = !sub.classList.contains("cc-open");
    for (const s of rows.querySelectorAll<HTMLElement>(".cc-export-sub.cc-open")) {
      s.classList.remove("cc-open");
    }
    if (willOpen) sub.classList.add("cc-open");
  }
}

async function runAction(
  state: ExportState,
  item: HTMLElement,
  action: ExportAction,
  scope: ExportScope,
): Promise<void> {
  const md = await currentMarkdown(state, scope);
  if (state.ctx.signal.aborted || !item.isConnected) return;
  if (md === null) {
    flash(state, item, "couldn't read the conversation", false);
    return;
  }
  if (action === "copy") {
    const ok = await copyText(state, md);
    if (state.ctx.signal.aborted || !item.isConnected) return;
    flash(
      state,
      item,
      ok ? `copied (${scope === "all" ? "everything" : "Claude only"}) ✓` : "copy failed",
      ok,
    );
  } else if (action === "download") {
    downloadMarkdown(state, md, scope === "all" ? "handoff.md" : "handoff-claude-only.md");
    flash(state, item, "saved to Downloads ✓", true);
  } else {
    // Send the SAME markdown copy/download build, over the bus contract; the
    // claude-code-bridge feature envelopes + pushes it (features never import
    // each other). "claude" → HandoffScope "answers"; "all" → "conversation"
    // carrying the prebuilt body. The ✓/reason flash arrives on
    // bridge:send-result — the mount handler pairs it back to this row by reqId.
    const reqId = crypto.randomUUID();
    state.sendPending = { item, reqId };
    markSending(state, item); // immediate "Sending…" + aria-busy
    state.ctx.bus.emit("bridge:send", {
      handle: "context",
      scope: scope === "claude" ? "answers" : "conversation",
      body: md,
      reqId,
    });
  }
}

/** Immediate in-flight face for the Send row: swap the detail line to "Sending…"
 *  and mark the row aria-busy the instant the send is emitted — the same idiom
 *  the answer-toolbar popover uses, so the ack wait never reads as a dead click.
 *  Superseded by flash() when the result lands (it bumps the shared flashGen),
 *  or self-restored after 8 s if no result ever arrives (e.g. the tab aborts its
 *  push). */
function markSending(state: ExportState, item: HTMLElement): void {
  const row = item.querySelector<HTMLElement>(".cc-export-row");
  const l2 = item.querySelector<HTMLElement>(".cc-export-l2");
  if (!row || !l2) return;
  row.setAttribute("aria-busy", "true");
  l2.textContent = "Sending…";
  l2.classList.remove("cc-ok-text", "cc-danger-text");
  const gen = String(++flashGen);
  item.dataset["flashGen"] = gen;
  state.ctx.setTimeout(() => {
    if (item.dataset["flashGen"] !== gen || !item.isConnected) return;
    row.removeAttribute("aria-busy");
    l2.textContent = restingDetail(item);
    l2.classList.remove("cc-ok-text", "cc-danger-text");
  }, 8000);
}

/** Green ✓ + status in the detail line for 1.8 s, then restore. */
function flash(state: ExportState, item: HTMLElement, msg: string, ok: boolean): void {
  const ic = item.querySelector<HTMLElement>(".cc-export-ic");
  const l2 = item.querySelector<HTMLElement>(".cc-export-l2");
  if (!ic || !l2) return;
  // The result supersedes any in-flight "Sending…" — drop its busy marker.
  item.querySelector<HTMLElement>(".cc-export-row")?.removeAttribute("aria-busy");
  const prevIcon = ic.innerHTML;
  if (ok) {
    ic.innerHTML = ICON_CHECK; // static, trusted markup
    ic.classList.add("cc-ok-text");
  }
  l2.textContent = msg;
  l2.classList.toggle("cc-ok-text", ok);
  l2.classList.toggle("cc-danger-text", !ok);

  const gen = String(++flashGen);
  item.dataset["flashGen"] = gen;
  state.ctx.setTimeout(() => {
    if (item.dataset["flashGen"] !== gen || !item.isConnected) return;
    ic.innerHTML = prevIcon;
    ic.classList.remove("cc-ok-text", "cc-sent-pulse");
    l2.textContent = restingDetail(item);
    l2.classList.remove("cc-ok-text", "cc-danger-text");
  }, FLASH_MS);
}

/** Play the shared "sent ✓" success pulse (companion.css cc-sent-pulse) on the
 *  Send row's icon — the same brief scale bump + green glow every send surface
 *  uses. Cleared by a managed timer; inert under prefers-reduced-motion (the ✓
 *  is the feedback). */
function pulseSent(state: ExportState, item: HTMLElement): void {
  const ic = item.querySelector<HTMLElement>(".cc-export-ic");
  if (!ic) return;
  ic.classList.add("cc-sent-pulse");
  state.ctx.setTimeout(() => ic.classList.remove("cc-sent-pulse"), PULSE_MS);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function copyText(state: ExportState, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be denied without document focus — legacy fallback.
    try {
      const ta = ownedEl("textarea", { owner: OWNER, className: "cc-export-clip" });
      ta.value = text;
      state.ctx.root.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function downloadMarkdown(state: ExportState, md: string, filename: string): void {
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  state.pendingUrls.add(url);
  const a = ownedEl("a", { owner: OWNER });
  a.href = url;
  a.download = filename;
  a.click();
  state.ctx.setTimeout(() => {
    URL.revokeObjectURL(url);
    state.pendingUrls.delete(url);
  }, URL_REVOKE_MS);
}
