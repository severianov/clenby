/**
 * Usage popover — Tier 3, session scope.
 *
 * Behavior:
 * - A gauge icon in the composer-inline group — SHARED CONTRACT with
 *   undo-send: one group `#cc-composer-grp` (created by whichever of the two
 *   mounts/re-places first) inserted inside claude's composer action row
 *   immediately before the voice/dictation button group; each feature owns
 *   its own `.cc-composer-slot` inside it (`#cc-undo-inline`,
 *   `#cc-usage-inline`), ordered [undo][usage]. Re-placed on a ctx interval;
 *   quietly absent when the row can't be found.
 * - Click → popover rendering ctx.api.getUsage(): the newer `limits[]` array
 *   (session / week-all-models / per-model "(week)" rows, straight
 *   from the API's display_name) with severity colors, percent bars and reset
 *   countdowns; falls back to the legacy five_hour/seven_day(+per-model)
 *   window fields when `limits` is absent. Optional spend line.
 * - "same data as Settings → Usage · unofficial API" footnote.
 * - Refresh ON OPEN + on `generation:end` while open — NEVER polls.
 *
 * NOTE: the voice-button row lookup is an aria-label heuristic local to this
 * file; it belongs in core/selectors.ts the next time that file is revised.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import type { Usage, UsageLimit, UsageWindow } from "@/api/types";
import { ownedEl, setGeometry } from "@/ui/root";
import { countdown } from "@/shared/time";

const ID = "usage";

/** lucide "gauge" — matches claude's icon style (stroke: currentColor). */
const GAUGE_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/></svg>';

// Claude-facing lookups (see file header note re: selectors.ts freeze).
const VOICE_LABEL_RE = /voice|dictat|record/i;
const VOICE_BTN_CSS =
  'button[aria-label*="voice" i], button[aria-label*="dictat" i], button[aria-label*="record" i]';
const COMPOSER_ROW_CSS = ".relative.flex.items-center.w-full";

/** Composer-membership guard (mirrors undo-send): a voice-labeled button only
 *  counts when a near ancestor also holds the contenteditable input — else a
 *  voice-note row on the chats & tasks list would capture the inline group. */
function isComposerVoiceButton(b: HTMLElement): boolean {
  let node: HTMLElement | null = b;
  for (let i = 0; i < 8 && node; i++) {
    const tag = node.tagName;
    if (tag === "MAIN" || tag === "ASIDE" || tag === "BODY") return false;
    if (node.querySelector('div[contenteditable="true"]')) return true;
    node = node.parentElement;
  }
  return false;
}

function findComposerActionRow(): HTMLElement | null {
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]"))) {
    if (!VOICE_LABEL_RE.test(b.getAttribute("aria-label") ?? "")) continue;
    if (!isComposerVoiceButton(b)) continue;
    const row = b.closest<HTMLElement>(COMPOSER_ROW_CSS);
    if (row) return row;
    const up = b.parentElement?.parentElement?.parentElement?.parentElement ?? null;
    if (up) return up;
  }
  return null;
}

function voiceGroupIn(row: HTMLElement): Element | null {
  for (const child of Array.from(row.children)) {
    if (child.querySelector(VOICE_BTN_CSS)) return child;
  }
  return null;
}

/**
 * The shared composer-inline group (contract with the undo-send feature):
 * find or create `#cc-composer-grp` and keep it parked in the action row
 * before the voice group. Returns null when the row isn't available.
 */
function ensureComposerGroup(creatorId: string): HTMLElement | null {
  let group = document.getElementById("cc-composer-grp");
  if (!group) {
    group = ownedEl("div", { owner: creatorId, attrs: { id: "cc-composer-grp" } });
  }
  const row = findComposerActionRow();
  if (!row) return null;
  if (group.parentElement !== row) {
    try {
      row.insertBefore(group, voiceGroupIn(row));
    } catch {
      return null; // row mid-re-render — retry next tick
    }
  }
  return group;
}

function labelOf(limit: UsageLimit): string {
  if (limit.kind === "session") return "Session (5h)";
  if (limit.kind === "weekly_all") return "Week — all models";
  const name = limit.scope?.model?.display_name;
  if (typeof name === "string" && name) return `${name} (week)`;
  return typeof limit.kind === "string" && limit.kind ? limit.kind.replace(/_/g, " ") : "Limit";
}

/** Severity → bar class; API severity wins, percent thresholds otherwise. */
function severityClass(pct: number, severity: string | undefined): string {
  if (severity === "critical" || severity === "exceeded") return "cc-sev-crit";
  if (severity === "warning") return "cc-sev-warn";
  if (pct < 60) return "cc-sev-ok";
  if (pct < 85) return "cc-sev-warn";
  return "cc-sev-crit";
}

export const usage: FeatureModule = {
  id: ID,
  tier: 3,
  scope: "session",

  mount(ctx: FeatureContext) {
    let open = false;
    let requestSeq = 0;

    // ---- inline slot + gauge button (composer-inline group contract) ----
    const slot = ownedEl("div", {
      owner: ID,
      className: "cc-composer-slot",
      attrs: { id: "cc-usage-inline" },
    });
    const btn = ownedEl("button", {
      owner: ID,
      className: "cc-inline-btn",
      attrs: {
        id: "cc-usage-btn",
        type: "button",
        title: "Usage & limits",
        "aria-label": "Usage & limits",
        "aria-haspopup": "dialog",
      },
    });
    btn.innerHTML = GAUGE_SVG;
    slot.appendChild(btn);
    ctx.onCleanup(() => slot.remove());

    // ---- popover (top-level UI → under #cc-root) ----
    const pop = ownedEl("div", {
      owner: ID,
      className: "cc-popover cc-usage-pop",
      attrs: { id: "cc-pop-usage", role: "dialog", "aria-label": "Usage and limits" },
    });
    pop.style.display = "none";
    ctx.root.appendChild(pop);
    ctx.onCleanup(() => pop.remove());

    // ---- rendering ----
    const el = (className: string, text?: string): HTMLElement => {
      const opts: Parameters<typeof ownedEl<"div">>[1] = { owner: ID, className };
      if (text !== undefined) opts.text = text;
      return ownedEl("div", opts);
    };

    const addRow = (
      label: string,
      pct: number,
      severity: string | undefined,
      resetsAt: string | undefined,
      active: boolean,
    ): void => {
      const clamped = Math.max(0, Math.min(100, pct));
      const row = el("cc-usage-row");
      const name = ownedEl("span", { owner: ID, text: label });
      if (active) {
        const marker = ownedEl("span", { owner: ID, className: "cc-faint", text: " · active" });
        name.appendChild(marker);
      }
      const value = ownedEl("span", { owner: ID, className: "cc-pct", text: `${Math.round(pct)}%` });
      row.append(name, value);
      pop.appendChild(row);

      const bar = el("cc-usage-bar");
      const fill = el(`cc-usage-fill ${severityClass(clamped, severity)}`);
      fill.style.width = `${clamped}%`; // geometry-only inline style
      bar.appendChild(fill);
      pop.appendChild(bar);

      const reset = typeof resetsAt === "string" && resetsAt ? countdown(resetsAt) : "";
      pop.appendChild(el("cc-usage-reset", reset));
    };

    const renderUsage = (data: Usage): void => {
      pop.textContent = "";
      pop.appendChild(el("cc-usage-title", "Usage"));

      const limits = (data.limits ?? []).filter(
        (l): l is UsageLimit & { percent: number } =>
          typeof l.percent === "number" && Number.isFinite(l.percent),
      );

      if (limits.length > 0) {
        for (const l of limits) {
          addRow(
            labelOf(l),
            l.percent,
            typeof l.severity === "string" ? l.severity : undefined,
            typeof l.resets_at === "string" ? l.resets_at : undefined,
            l.is_active === true,
          );
        }
      } else {
        // Legacy window fields (the older payload shape).
        const windows: ReadonlyArray<readonly [string, UsageWindow | null | undefined]> = [
          ["Session (5h)", data.five_hour],
          ["Week", data.seven_day],
          ["Opus (week)", data.seven_day_opus],
          ["Sonnet (week)", data.seven_day_sonnet],
          ["Cowork (week)", data.seven_day_cowork],
        ];
        let any = false;
        for (const [label, w] of windows) {
          if (!w || typeof w.utilization !== "number") continue;
          any = true;
          addRow(label, w.utilization, undefined, w.resets_at, false);
        }
        if (!any) pop.appendChild(el("cc-muted", "No usage data available."));
      }

      const used = data.spend?.enabled === true ? data.spend.used : undefined;
      if (
        used &&
        typeof used.amount_minor === "number" &&
        typeof used.exponent === "number" &&
        typeof used.currency === "string"
      ) {
        const amount = (used.amount_minor / Math.pow(10, used.exponent)).toFixed(2);
        pop.appendChild(el("cc-usage-spend", `Extra credits used: ${amount} ${used.currency}`));
      }

      pop.appendChild(el("cc-usage-note", "same data as Settings → Usage · unofficial API"));
    };

    const refresh = async (): Promise<void> => {
      const seq = ++requestSeq;
      pop.textContent = "";
      pop.appendChild(el("cc-muted", "Loading usage…"));
      const res = await ctx.api.getUsage(ctx.signal);
      if (ctx.signal.aborted || seq !== requestSeq || !open) return;
      if (!res.ok) {
        pop.textContent = "";
        pop.appendChild(el("cc-danger-text", "Could not load usage."));
        pop.appendChild(el("cc-usage-note", "same data as Settings → Usage · unofficial API"));
        return;
      }
      renderUsage(res.data);
    };

    // ---- open / close ----
    const close = (): void => {
      if (!open) return;
      open = false;
      pop.style.display = "none";
      btn.classList.remove("cc-open");
    };

    const openPop = (): void => {
      open = true;
      const r = btn.getBoundingClientRect();
      setGeometry(pop, {
        left: Math.max(8, r.left - 130),
        top: r.top - 10,
        transform: "translateY(-100%)",
      });
      pop.style.display = "block";
      btn.classList.add("cc-open");
      void refresh(); // refresh on open — never poll
    };

    ctx.listen(btn, "click", (ev: MouseEvent) => {
      ev.stopPropagation();
      if (open) close();
      else openPop();
    });
    ctx.listen(document, "mousedown", (ev: MouseEvent) => {
      if (!open) return;
      const target = ev.target;
      if (target instanceof Element && (target.closest("#cc-pop-usage") || target.closest("#cc-usage-inline")))
        return;
      close();
    });
    ctx.listen(
      document,
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.key === "Escape" && open) close();
      },
      { capture: true },
    );
    ctx.on("generation:end", () => {
      if (open) void refresh();
    });

    // ---- composer-inline placement (shared contract with undo-send) ----
    const place = (): void => {
      const group = ensureComposerGroup(ID);
      if (!group) {
        if (slot.parentElement) slot.remove();
        if (open) close();
        return;
      }
      if (slot.parentElement !== group) group.appendChild(slot);
    };
    ctx.setInterval(place, 700);
    place();
  },
};
