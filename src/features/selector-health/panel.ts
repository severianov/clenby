/**
 * Selector Health panel DOM — chrome only, no data and no listeners
 * (index.ts wires those). Mirrors the approved self-healing mockup: a
 * centered dev-tool card with a break-alert strip, the anchors dashboard
 * table, and the merged override editor underneath.
 *
 * Conventions: everything built with ownedEl (runtime sweep safety net), all
 * visuals from companion.css via var(--cc-*), z from the Z.chip band like the
 * command palette (the two never overlap — index.ts closes this panel when
 * the palette opens).
 */

import { ownedEl } from "@/ui/root";

export const PANEL_ID = "cc-sh-panel";

export interface HealthPanelRefs {
  scrim: HTMLDivElement;
  panel: HTMLDivElement;
  headSub: HTMLSpanElement;
  closeBtn: HTMLButtonElement;
  /** index.ts renders the healthy/broken banner strip into this host. */
  bannerHost: HTMLDivElement;
  /** The "Repair with Claude" card mounts here (repair.ts), between the
   *  banner strip and the dashboard. */
  repairHost: HTMLDivElement;
  /** The dashboard's <tbody>. */
  tableBody: HTMLTableSectionElement;
  /** Export / import controls in the editor header. */
  exportBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  fileInput: HTMLInputElement;
  /** One-line import/export result readout (hidden until used). */
  edStatus: HTMLDivElement;
  /** The merged-anchors editor list host. */
  edHost: HTMLDivElement;
  /** Report actions — always present, not only when something is broken: a
   *  feature can misbehave while every anchor still reports healthy, and that
   *  report is the most interesting one to receive. */
  reportCopyBtn: HTMLButtonElement;
  reportIssueBtn: HTMLButtonElement;
  /** One-line copy/open readout (hidden until used). */
  reportStatus: HTMLDivElement;
}

const DASH_COLUMNS: readonly string[] = ["Anchor", "Status", "Used by", "Last matched", ""];

/** Build the full panel chrome (scrim + card). Hidden until opened. */
export function buildHealthPanel(owner: string): HealthPanelRefs {
  const scrim = ownedEl("div", { owner, className: "cc-sh-scrim cc-hidden" });
  const panel = ownedEl("div", {
    owner,
    className: "cc-sh-panel cc-hidden",
    attrs: { id: PANEL_ID, role: "dialog", "aria-label": "Selector health" },
  });

  // ---- header --------------------------------------------------------------
  const head = ownedEl("div", { owner, className: "cc-sh-head" });
  const headSub = ownedEl("span", { owner, className: "cc-sh-head-sub" });
  const closeBtn = ownedEl("button", {
    owner,
    className: "cc-sh-x",
    text: "✕",
    attrs: { type: "button", title: "Close", "aria-label": "Close selector health" },
  });
  head.append(
    ownedEl("span", { owner, className: "cc-sh-head-t", text: "Selector health" }),
    ownedEl("span", { owner, className: "cc-sh-head-d", text: "anchors into claude.ai" }),
    headSub,
    closeBtn,
  );

  const body = ownedEl("div", { owner, className: "cc-sh-body" });

  // ---- break-alert / all-healthy strip ------------------------------------
  const bannerHost = ownedEl("div", { owner, className: "cc-sh-banner-host" });

  // ---- repair card host (repair.ts mounts the card; empty host collapses) --
  const repairHost = ownedEl("div", { owner, className: "cc-sr-host" });

  // ---- dashboard card ------------------------------------------------------
  const dashCard = ownedEl("div", { owner, className: "cc-sh-card" });
  const table = ownedEl("table", { owner, className: "cc-sh-dash" });
  const thead = ownedEl("thead", { owner });
  const headRow = ownedEl("tr", { owner });
  for (const col of DASH_COLUMNS) {
    headRow.append(ownedEl("th", { owner, text: col, attrs: { scope: "col" } }));
  }
  thead.append(headRow);
  const tableBody = ownedEl("tbody", { owner });
  table.append(thead, tableBody);
  dashCard.append(table);

  // ---- editor card ---------------------------------------------------------
  const edCard = ownedEl("div", { owner, className: "cc-sh-card" });
  const edHead = ownedEl("div", { owner, className: "cc-sh-ed-head" });
  const exportBtn = ownedEl("button", {
    owner,
    className: "cc-btn",
    text: "Export…",
    attrs: { type: "button", title: "Download your overrides as a JSON file" },
  });
  const importBtn = ownedEl("button", {
    owner,
    className: "cc-btn",
    text: "Import…",
    attrs: { type: "button", title: "Import an overrides JSON file (validated on import)" },
  });
  const fileInput = ownedEl("input", {
    owner,
    className: "cc-sh-file",
    attrs: { type: "file", accept: ".json,application/json", "aria-hidden": "true", tabindex: "-1" },
  });
  edHead.append(
    ownedEl("span", { owner, className: "cc-sh-ed-t", text: "Merged anchors" }),
    ownedEl("span", {
      owner,
      className: "cc-sh-ed-path",
      text: "storage.local · cc:overrides:selectors / cc:overrides:endpoints",
    }),
    exportBtn,
    importBtn,
    fileInput,
  );
  const edStatus = ownedEl("div", {
    owner,
    className: "cc-sh-ed-status cc-hidden",
    attrs: { role: "status" },
  });
  const edHost = ownedEl("div", { owner, className: "cc-sh-ed" });
  const edNote = ownedEl("div", {
    owner,
    className: "cc-sh-ed-note",
    text:
      "🔒 shipped defaults — always kept as fallbacks under your overrides · " +
      "overrides are validated on write: data only, allowlisted names, same-origin /api/… paths.",
  });
  edCard.append(edHead, edStatus, edHost, edNote);

  // ---- report footer -------------------------------------------------------
  // Deliberately the last thing in the panel: repair first (fixes it now for
  // this user), report second (fixes it for everyone). Nothing is ever sent —
  // both buttons hand the text to the user, who submits it themselves.
  const foot = ownedEl("div", { owner, className: "cc-sh-foot" });
  const reportCopyBtn = ownedEl("button", {
    owner,
    className: "cc-btn",
    text: "Copy report",
    attrs: { type: "button", title: "Copy the diagnostic report to your clipboard" },
  });
  const reportIssueBtn = ownedEl("button", {
    owner,
    className: "cc-sh-btn-accent",
    text: "Open a GitHub issue ↗",
    attrs: {
      type: "button",
      title: "Open a prefilled issue on the Clenby repository — you review and submit it",
    },
  });
  foot.append(
    ownedEl("span", { owner, className: "cc-sh-foot-t", text: "Report a break" }),
    ownedEl("span", {
      owner,
      className: "cc-sh-foot-d",
      text: "anchor names, health counters and element paths only — never message text",
    }),
    reportCopyBtn,
    reportIssueBtn,
  );
  const reportStatus = ownedEl("div", {
    owner,
    className: "cc-sh-foot-status cc-hidden",
    attrs: { role: "status" },
  });

  body.append(bannerHost, repairHost, dashCard, edCard, foot, reportStatus);
  panel.append(head, body);

  return {
    scrim,
    panel,
    headSub,
    closeBtn,
    bannerHost,
    repairHost,
    tableBody,
    exportBtn,
    importBtn,
    fileInput,
    edStatus,
    edHost,
    reportCopyBtn,
    reportIssueBtn,
    reportStatus,
  };
}

export interface AlertRefs {
  alert: HTMLDivElement;
  msg: HTMLSpanElement;
  repairBtn: HTMLButtonElement;
  laterBtn: HTMLButtonElement;
}

/** The floating break-alert banner (top center, shown outside the panel). */
export function buildAlert(owner: string): AlertRefs {
  const alert = ownedEl("div", {
    owner,
    className: "cc-sh-alert cc-hidden",
    attrs: { role: "alert" },
  });
  const msg = ownedEl("span", { owner, className: "cc-sh-alert-msg" });
  const repairBtn = ownedEl("button", {
    owner,
    className: "cc-sh-btn-accent",
    text: "Repair…",
    attrs: { type: "button" },
  });
  const laterBtn = ownedEl("button", {
    owner,
    className: "cc-btn",
    text: "Later",
    attrs: { type: "button" },
  });
  alert.append(
    ownedEl("span", { owner, className: "cc-sh-alert-sig", text: "⚠", attrs: { "aria-hidden": "true" } }),
    msg,
    repairBtn,
    laterBtn,
  );
  return { alert, msg, repairBtn, laterBtn };
}
