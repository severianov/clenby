/**
 * Table extractor — Data & media. Conversation scope.
 *
 * A slim toolbar attached to every markdown table in assistant answers
 * (pins-style: additive owned node, maintenance sweep, delegated clicks,
 * swept on teardown). Claude's table DOM is NEVER restructured — the bar is
 * an additive owned node in NORMAL FLOW, inserted as a sibling right AFTER
 * the table's `div.overflow-x-auto` scroll wrapper (verified DOM 2026-07-21;
 * after the table itself when no wrapper exists), right-aligned BELOW the
 * table (2026-07-22: replaced the absolute bottom-right overlay, which
 * covered the table's last rows — below the table it never overlaps a cell
 * and stays clear of the answer hover-toolbar at the message's top-right).
 * The wrapper is taller than the table (the table's bottom margin is
 * contained by the wrapper's BFC) and carries its own bottom margin, so raw
 * flow position sits too far down — each bar is SNUGGED to ~3px under the
 * table's real bottom edge via a measured inline `position:relative` top
 * offset (re-checked every sweep; measured, never hardcoded, so it can't
 * overlap the last row and survives claude spacing changes).
 *
 * Virtualization-safe (2026-07-22): claude.ai unrenders off-screen messages,
 * so the table/wrapper can leave the DOM while a bar node lingers (or a
 * click lands on a bar whose table is mid-teardown). Every path that
 * resolves bar → table goes through the null-safe {@link tableOfBar}; the
 * sweep drops orphaned bars before equipping, and the click handler drops
 * the orphan it was clicked on instead of throwing. Re-attachment is free:
 * de-dupe is purely DOM-structural (no equipped-table bookkeeping), so when
 * the message re-renders the next sweep equips the fresh table.
 * Every action runs over an EXTRACTED data model (thead/tbody → string[][])
 * parsed read-only per click.
 *
 * Actions:
 * - Copy as TSV  — clipboard, tab-separated (tabs/newlines inside cells are
 *   flattened to spaces), ✓ flash.
 * - Download CSV — Blob + anchor click as `table.csv`, RFC-style escaping
 *   (quotes doubled; cells with commas/quotes/newlines wrapped in quotes),
 *   URLs revoked after 5 s and at unmount.
 * - Expand       — the table re-rendered in a full-screen own-UI overlay
 *   under #cc-root: sticky header, SORTABLE columns, copy/download, Esc /
 *   scrim / ✕ to close.
 *
 * Sorting design choice (own-UI safety): sorting happens ONLY inside the
 * expanded overlay, which renders OUR copy of the extracted model — claude's
 * table is never reordered, so there is nothing to reset and the dom-matcher
 * / copy paths can never observe a mutated answer. Header clicks cycle
 * asc → desc → original order; numeric-aware comparator (currency/percent/
 * thousands separators stripped) with locale string fallback.
 *
 * The bar renders SVG-only buttons and a dimensions badge via ::before
 * content:attr(data-cc-dim) — it adds ZERO characters to the answer's
 * innerText (dom-matcher probes, folding fold-heads, selection and copy all
 * stay clean).
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl } from "@/ui/root";

const OWNER = "table-extractor";

const SWEEP_MS = 900;
const FLASH_MS = 1400;
const URL_REVOKE_MS = 5000;
/** Target visual gap between the table's bottom edge and the bar. */
const SNUG_GAP_PX = 3;

// Lucide-style line icons — static, trusted markup (bundled constants,
// stroke: currentColor; no emoji, matching the header-cluster convention).
const ICON_COPY =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_DOWNLOAD =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
const ICON_EXPAND =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/></svg>';
const ICON_CHECK =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_CLOSE =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const ICON_RESET =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

/** The extracted, own-UI data model — parsed once per action. */
export interface TableModel {
  header: string[];
  rows: string[][];
  cols: number;
}

/** Normalized cell text: whitespace collapsed, trimmed. */
function cellText(cell: Element): string {
  return (cell.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Parse a rendered table (read-only) into the extracted model. */
export function parseTable(table: HTMLTableElement): TableModel {
  const headRow = table.tHead?.rows[0] ?? null;
  const header = headRow ? [...headRow.cells].map(cellText) : [];
  const rows: string[][] = [];
  for (const body of table.tBodies) {
    for (const tr of body.rows) rows.push([...tr.cells].map(cellText));
  }
  // Header-less tables: fall back to every row incl. any thead-less first row.
  if (header.length === 0 && rows.length === 0) {
    for (const tr of table.rows) rows.push([...tr.cells].map(cellText));
  }
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 0);
  return { header, rows, cols };
}

/** One CSV field, RFC-4180 escaping. */
export function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(model: TableModel): string {
  const lines: string[] = [];
  if (model.header.length > 0) lines.push(model.header.map(csvField).join(","));
  for (const row of model.rows) lines.push(row.map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function toTsv(model: TableModel): string {
  const flat = (v: string): string => v.replace(/[\t\n\r]+/g, " ");
  const lines: string[] = [];
  if (model.header.length > 0) lines.push(model.header.map(flat).join("\t"));
  for (const row of model.rows) lines.push(row.map(flat).join("\t"));
  return lines.join("\n");
}

/** Numeric-aware cell value: strips currency/percent/thousands noise. */
function numericValue(v: string): number | null {
  const cleaned = v.replace(/[$€£¥%,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (cleaned === "" || !/^[+-]?\d*\.?\d+([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** asc comparator for one column; numeric when both sides parse as numbers. */
export function compareCells(a: string, b: string): number {
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1; // numbers sort before text
  if (nb !== null) return 1;
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

type SortDir = "asc" | "desc" | null;

let flashGen = 0;

export const tableExtractor: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "conversation",

  async mount(ctx: FeatureContext) {
    let barsOn = true;
    const pendingUrls = new Set<string>();

    // ---- discovery -----------------------------------------------------------

    /** Rendered markdown tables in the thread (thread-only guard: artifact /
     *  document viewer tables never get a toolbar). */
    const tables = (): HTMLTableElement[] =>
      ctx.selectors
        .queryAll<HTMLTableElement>("assistantTable")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);

    /** The element the bar is inserted AFTER: the overflow-x-auto scroll
     *  wrapper when present (verified DOM), else the table itself. */
    const hostOf = (table: HTMLTableElement): HTMLElement => {
      const parent = table.parentElement;
      return parent && parent.classList.contains("overflow-x-auto") ? parent : table;
    };

    /** The mounted bar for a host: always its NEXT SIBLING (in-flow row
     *  below the table). */
    const barOf = (host: HTMLElement): HTMLElement | null => {
      const next = host.nextElementSibling;
      return next instanceof HTMLElement && next.classList.contains("cc-tx-bar") ? next : null;
    };

    /** Every OUR bar currently in the document. */
    const allBars = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>(`.cc-tx-bar[data-cc-owner="${OWNER}"]`),
    ];

    /** The host table a mounted bar belongs to, or null when it's gone —
     *  claude's virtualization unrenders off-screen messages, so the
     *  table/wrapper can vanish while the bar node lingers. Never throws on
     *  detached/orphaned bars: this is THE resolver for every bar → table
     *  path (sweep orphan-drop, click handler). */
    const tableOfBar = (bar: HTMLElement): HTMLTableElement | null => {
      if (!bar.isConnected) return null;
      const anchor = bar.previousElementSibling;
      if (anchor instanceof HTMLTableElement) return anchor;
      return anchor?.querySelector("table") ?? null;
    };

    /** Pull the bar up to ~{@link SNUG_GAP_PX}px under the table's REAL
     *  bottom edge. The scroll wrapper is taller than the table (contained
     *  bottom margin) and has its own bottom margin, so pure flow position
     *  sits too far down. Measured per bar (never a hardcoded claude
     *  spacing), applied as a relative `top` offset — the bar stays in flow
     *  and, because the correction is derived from live rects, it can never
     *  be pulled over the table's last row. Re-run every sweep: convergence
     *  is exact (gap responds 1:1 to `top`), so a settled bar is a no-op,
     *  while zoom/re-layout/theme changes self-correct within one sweep. */
    const snug = (table: HTMLTableElement, bar: HTMLElement): void => {
      const t = table.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      if (t.height === 0 || b.height === 0) return; // hidden / not laid out
      const delta = b.top - t.bottom - SNUG_GAP_PX;
      if (Math.abs(delta) < 0.5) return; // settled
      const current = Number.parseFloat(bar.style.top) || 0;
      bar.style.top = `${current - delta}px`;
    };

    // ---- shared helpers ------------------------------------------------------

    const copyText = async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Clipboard API can be denied without document focus — legacy fallback.
        try {
          const ta = ownedEl("textarea", { owner: OWNER, className: "cc-tx-clip" });
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

    /** Brief ✓ (or danger tint) on the pressed button, then restore. */
    const flash = (btn: HTMLButtonElement, ok: boolean): void => {
      const prev = btn.innerHTML;
      btn.innerHTML = ICON_CHECK; // static, trusted markup
      btn.classList.add(ok ? "cc-tx-done" : "cc-tx-fail");
      const gen = String(++flashGen);
      btn.dataset["ccFlash"] = gen;
      ctx.setTimeout(() => {
        if (btn.dataset["ccFlash"] !== gen || !btn.isConnected) return;
        btn.innerHTML = prev;
        btn.classList.remove("cc-tx-done", "cc-tx-fail");
      }, FLASH_MS);
    };

    const downloadCsv = (model: TableModel): void => {
      const blob = new Blob([toCsv(model)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      pendingUrls.add(url);
      const a = ownedEl("a", { owner: OWNER });
      a.href = url;
      a.download = "table.csv";
      a.click();
      ctx.setTimeout(() => {
        URL.revokeObjectURL(url);
        pendingUrls.delete(url);
      }, URL_REVOKE_MS);
    };

    // ---- inline toolbar ------------------------------------------------------

    const mkBtn = (act: string, label: string, icon: string): HTMLButtonElement => {
      const btn = ownedEl("button", {
        owner: OWNER,
        className: "cc-tx-btn",
        attrs: { type: "button", title: label, "aria-label": label, "data-cc-act": act },
      });
      btn.innerHTML = icon; // static, trusted markup (bundled constants)
      return btn;
    };

    const buildBar = (model: TableModel): HTMLElement => {
      const bar = ownedEl("div", {
        owner: OWNER,
        className: "cc-tx-bar",
        attrs: { role: "toolbar", "aria-label": "Table tools" },
      });
      // Badge renders via ::before content:attr(data-cc-dim) — zero innerText
      // added to the answer (the innerText-invisible badge technique).
      bar.append(
        ownedEl("span", {
          owner: OWNER,
          className: "cc-tx-dim",
          attrs: {
            "aria-hidden": "true",
            "data-cc-dim": `${model.rows.length}×${model.cols}`,
          },
        }),
        mkBtn("copy", "Copy table as TSV", ICON_COPY),
        mkBtn("download", "Download table as CSV", ICON_DOWNLOAD),
        mkBtn("expand", "Expand table (sortable full-screen view)", ICON_EXPAND),
      );
      return bar;
    };

    const equip = (table: HTMLTableElement): void => {
      // Virtualization guard: the table can leave the DOM between discovery
      // and equip (and detached nodes must never be measured or decorated).
      if (!table.isConnected) return;
      const host = hostOf(table);
      const mounted = barOf(host);
      if (mounted) {
        // De-duped — keep the dimensions badge fresh (streaming tables grow).
        const badge = mounted.querySelector<HTMLElement>(".cc-tx-dim");
        if (badge) {
          const model = parseTable(table);
          const dim = `${model.rows.length}×${model.cols}`;
          if (badge.getAttribute("data-cc-dim") !== dim) badge.setAttribute("data-cc-dim", dim);
        }
        snug(table, mounted);
        return;
      }
      // In-flow row directly BELOW the table: sibling right after the scroll
      // wrapper (or after the table itself when no wrapper exists) — never
      // overlaps a cell.
      const bar = buildBar(parseTable(table));
      host.after(bar);
      // after() is a silent no-op when the host detached mid-equip — only a
      // bar that actually landed in the DOM gets measured.
      if (bar.isConnected) snug(table, bar);
    };

    const removeAll = (): void => {
      for (const el of allBars()) el.remove();
    };

    // ---- expanded overlay (own UI under #cc-root) ----------------------------

    interface Overlay {
      el: HTMLElement;
      tbody: HTMLElement;
      ths: HTMLElement[];
      model: TableModel;
      sortCol: number;
      sortDir: SortDir;
      returnFocus: HTMLElement | null;
    }
    let overlay: Overlay | null = null;

    const closeOverlay = (): void => {
      if (!overlay) return;
      overlay.el.remove();
      const back = overlay.returnFocus;
      overlay = null;
      if (back && back.isConnected) back.focus();
    };

    const renderBody = (o: Overlay): void => {
      let rows = o.model.rows;
      if (o.sortDir !== null && o.sortCol >= 0) {
        const dir = o.sortDir === "asc" ? 1 : -1;
        rows = [...rows].sort(
          (a, b) => dir * compareCells(a[o.sortCol] ?? "", b[o.sortCol] ?? ""),
        );
      }
      const frag = document.createDocumentFragment();
      for (const row of rows) {
        const tr = ownedEl("tr", { owner: OWNER });
        for (let c = 0; c < o.model.cols; c++) {
          tr.append(ownedEl("td", { owner: OWNER, text: row[c] ?? "" }));
        }
        frag.append(tr);
      }
      o.tbody.replaceChildren(frag);
      o.ths.forEach((th, i) => {
        const state = o.sortDir !== null && o.sortCol === i ? o.sortDir : "none";
        th.setAttribute("data-cc-sort", state);
        th.setAttribute(
          "aria-sort",
          state === "asc" ? "ascending" : state === "desc" ? "descending" : "none",
        );
      });
    };

    const cycleSort = (o: Overlay, col: number): void => {
      if (o.sortCol !== col || o.sortDir === null) {
        o.sortCol = col;
        o.sortDir = "asc";
      } else if (o.sortDir === "asc") {
        o.sortDir = "desc";
      } else {
        o.sortDir = null; // back to original order
      }
      renderBody(o);
    };

    const openOverlay = (model: TableModel, trigger: HTMLElement | null): void => {
      closeOverlay();

      const el = ownedEl("div", {
        owner: OWNER,
        className: "cc-tx-overlay",
        attrs: { role: "dialog", "aria-modal": "true", "aria-label": "Expanded table" },
      });
      const panel = ownedEl("div", {
        owner: OWNER,
        className: "cc-tx-panel",
        attrs: { tabindex: "-1" },
      });

      // Header bar: title + actions. Own UI — plain text is fine here.
      const head = ownedEl("div", { owner: OWNER, className: "cc-tx-head" });
      const title = ownedEl("span", {
        owner: OWNER,
        className: "cc-tx-title",
        text: `Table · ${model.rows.length} rows × ${model.cols} columns`,
      });
      const hint = ownedEl("span", {
        owner: OWNER,
        className: "cc-tx-hint",
        text: "Click a column header to sort",
      });
      const resetBtn = mkBtn("o-reset", "Back to original row order", ICON_RESET);
      const copyBtn = mkBtn("o-copy", "Copy table as TSV", ICON_COPY);
      const dlBtn = mkBtn("o-download", "Download table as CSV", ICON_DOWNLOAD);
      const closeBtn = mkBtn("o-close", "Close (Esc)", ICON_CLOSE);
      head.append(title, hint, resetBtn, copyBtn, dlBtn, closeBtn);

      // Our re-rendered table (the extracted model — never claude's nodes).
      const scroll = ownedEl("div", { owner: OWNER, className: "cc-tx-scroll" });
      const tbl = ownedEl("table", { owner: OWNER, className: "cc-tx-table" });
      const thead = ownedEl("thead", { owner: OWNER });
      const headTr = ownedEl("tr", { owner: OWNER });
      const ths: HTMLElement[] = [];
      for (let c = 0; c < model.cols; c++) {
        const th = ownedEl("th", {
          owner: OWNER,
          attrs: { scope: "col", "data-cc-col": String(c), "data-cc-sort": "none" },
        });
        const thBtn = ownedEl("button", {
          owner: OWNER,
          className: "cc-tx-th",
          text: model.header[c] ?? `Column ${c + 1}`,
          attrs: { type: "button", title: "Sort by this column" },
        });
        th.append(thBtn);
        headTr.append(th);
        ths.push(th);
      }
      thead.append(headTr);
      const tbody = ownedEl("tbody", { owner: OWNER });
      tbl.append(thead, tbody);
      scroll.append(tbl);
      panel.append(head, scroll);
      el.append(panel);
      ctx.root.append(el);

      overlay = { el, tbody, ths, model, sortCol: -1, sortDir: null, returnFocus: trigger };
      renderBody(overlay);
      panel.focus();
    };

    // ---- delegated clicks ----------------------------------------------------

    ctx.listen(document, "click", (ev: MouseEvent) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target) return;

      // Inline bar actions.
      const btn = target.closest<HTMLButtonElement>(".cc-tx-btn");
      if (btn && btn.closest(`[data-cc-owner="${OWNER}"]`)) {
        ev.stopPropagation();
        const act = btn.dataset["ccAct"];

        if (act === "copy" || act === "download" || act === "expand") {
          const bar = btn.closest<HTMLElement>(".cc-tx-bar");
          // The bar always sits right after its host: the scroll wrapper
          // (normal case) or the table itself (no-wrapper case). Resolved
          // null-safely — virtualization can unrender the table between
          // paint and click.
          const table = bar ? tableOfBar(bar) : null;
          if (!table) {
            // Table gone (virtualized away / edited out): drop the orphaned
            // bar instead of leaving a dead control — and never throw.
            bar?.remove();
            return;
          }
          const model = parseTable(table);
          if (act === "copy") {
            const tsv = toTsv(model);
            void copyText(tsv).then((ok) => {
              if (ctx.signal.aborted) return;
              flash(btn, ok);
            });
          } else if (act === "download") {
            downloadCsv(model);
            flash(btn, true);
          } else {
            openOverlay(model, btn);
          }
          return;
        }

        // Overlay actions run on the overlay's model in its CURRENT sort order.
        if (!overlay) return;
        const o = overlay;
        const sortedModel = (): TableModel => {
          if (o.sortDir === null || o.sortCol < 0) return o.model;
          const dir = o.sortDir === "asc" ? 1 : -1;
          return {
            ...o.model,
            rows: [...o.model.rows].sort(
              (a, b) => dir * compareCells(a[o.sortCol] ?? "", b[o.sortCol] ?? ""),
            ),
          };
        };
        if (act === "o-copy") {
          const tsv = toTsv(sortedModel());
          void copyText(tsv).then((ok) => {
            if (ctx.signal.aborted) return;
            flash(btn, ok);
          });
        } else if (act === "o-download") {
          downloadCsv(sortedModel());
          flash(btn, true);
        } else if (act === "o-reset") {
          o.sortDir = null;
          o.sortCol = -1;
          renderBody(o);
        } else if (act === "o-close") {
          closeOverlay();
        }
        return;
      }

      // Overlay column-header sort.
      const th = target.closest<HTMLElement>(".cc-tx-th");
      if (th && overlay && th.closest(`[data-cc-owner="${OWNER}"]`)) {
        ev.stopPropagation();
        const col = Number.parseInt(th.parentElement?.dataset["ccCol"] ?? "", 10);
        if (Number.isFinite(col)) cycleSort(overlay, col);
        return;
      }

      // Scrim click closes (clicks inside the panel don't reach the overlay root).
      if (overlay && target === overlay.el) closeOverlay();
    });

    // Esc closes the overlay (capture — before claude.ai's own handlers).
    ctx.listen(
      document,
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !overlay) return;
        ev.preventDefault();
        ev.stopPropagation();
        closeOverlay();
      },
      { capture: true },
    );

    // ---- settings (gear "Data" row — no feature imports) ---------------------
    const settings = await ctx.storage.getSettings();
    if (ctx.signal.aborted) return;
    barsOn = settings.tableToolbarOn;

    ctx.onCleanup(
      ctx.storage.onSettingsChanged((next) => {
        const wasOn = barsOn;
        barsOn = next.tableToolbarOn;
        if (!barsOn && wasOn) {
          removeAll();
          closeOverlay();
        } else if (barsOn && !wasOn) {
          sweep();
        }
      }),
    );

    // ---- maintenance sweep (pins pattern) ------------------------------------
    const sweep = (): void => {
      if (!barsOn) return;
      // Orphans first: when virtualization unrenders a message, the
      // table/wrapper leave the DOM — any bar left behind (or whose sibling
      // no longer contains a table) is dead weight and must not linger. Bars
      // that left the DOM together with their subtree simply stop matching
      // the document query and are GC'd — no per-bar timers or listeners
      // exist (clicks are delegated on document; the only interval is this
      // ctx-managed sweep), so nothing can fire on a dead node.
      for (const bar of allBars()) {
        if (tableOfBar(bar) === null) bar.remove();
      }
      // Then equip: purely DOM-structural de-dupe, so a table that scrolled
      // back in after a virtualization round-trip gets a fresh bar here.
      for (const t of tables()) equip(t);
    };
    ctx.setInterval(sweep, SWEEP_MS);
    ctx.on("conversation:updated", sweep);
    sweep();

    // Full removal on teardown: bars + host classes swept (also caught by the
    // runtime owner-sweep), overlay closed, in-flight download URLs revoked.
    ctx.onCleanup(() => {
      closeOverlay();
      removeAll();
      for (const url of pendingUrls) URL.revokeObjectURL(url);
      pendingUrls.clear();
    });
  },
};
