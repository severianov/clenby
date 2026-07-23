/**
 * Copy / download for Claude Code — Tier 2, conversation scope.
 *
 * Markdown builder with an inline scope chooser and artifact-placeholder
 * cleanup.
 *
 * BEHAVIOR:
 * - Two menu rows — "Copy conversation" (⧉) and "Download handoff.md" (⬇) —
 *   each an icon + label + detail line. Clicking a row expands an inline
 *   SCOPE chooser: "Everything — you + Claude" / "Only Claude's answers".
 *   Picking a scope runs the action and flashes a green ✓ + status in the
 *   detail line for 1.8 s.
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
 * - `mountExportRows(container)` — clear `container` and render both rows
 *   into it. Call it whenever the gear menu (re)opens. Outside a conversation
 *   it renders a quiet empty state.
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

const DEFAULT_DETAIL = "choose what to include →";
const FLASH_MS = 1800;
const URL_REVOKE_MS = 5000;

// Lucide-style line icons (stroke: currentColor — colored by CSS classes).
const ICON_COPY =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_DOWNLOAD =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
const ICON_CHECK =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

interface ExportState {
  readonly ctx: FeatureContext;
  readonly pendingUrls: Set<string>;
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
    const state: ExportState = { ctx, pendingUrls: new Set() };
    active = state;
    ctx.onCleanup(() => {
      for (const url of state.pendingUrls) URL.revokeObjectURL(url);
      state.pendingUrls.clear();
      if (active === state) active = null;
    });

    // The header cluster owns the gear menu shell; it announces every open
    // on the bus with the `#cc-gear-export-slot` body (idempotent re-mount).
    ctx.on("ui:export-open", ({ container }) => mountExportRows(container));

    if (lastContainer?.isConnected) mountExportRows(lastContainer);
  },
};

// ---------------------------------------------------------------------------
// Host API (header-cluster / gear menu)
// ---------------------------------------------------------------------------

/** Render the two export rows into the gear menu's Export section body.
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

function buildRow(iconSvg: string, label: string, action: "copy" | "download"): HTMLElement {
  const item = ownedEl("div", { owner: OWNER, className: "cc-export-item" });

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
  sub.appendChild(buildOpt("Everything — you + Claude", "all", action));
  sub.appendChild(buildOpt("Only Claude’s answers", "claude", action));

  item.appendChild(row);
  item.appendChild(sub);
  return item;
}

function buildOpt(label: string, scope: ExportScope, action: "copy" | "download"): HTMLElement {
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
    const action = opt.dataset["action"] === "download" ? "download" : "copy";
    const item = opt.closest<HTMLElement>(".cc-export-item");
    if (!item) return;
    item.querySelector(".cc-export-sub")?.classList.remove("cc-open");
    void runAction(state, item, action, scope);
    return;
  }

  const row = t.closest<HTMLElement>(".cc-export-row");
  if (row) {
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
  action: "copy" | "download",
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
  } else {
    downloadMarkdown(state, md, scope === "all" ? "handoff.md" : "handoff-claude-only.md");
    flash(state, item, "saved to Downloads ✓", true);
  }
}

/** Green ✓ + status in the detail line for 1.8 s, then restore. */
function flash(state: ExportState, item: HTMLElement, msg: string, ok: boolean): void {
  const ic = item.querySelector<HTMLElement>(".cc-export-ic");
  const l2 = item.querySelector<HTMLElement>(".cc-export-l2");
  if (!ic || !l2) return;
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
    ic.classList.remove("cc-ok-text");
    l2.textContent = DEFAULT_DETAIL;
    l2.classList.remove("cc-ok-text", "cc-danger-text");
  }, FLASH_MS);
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
