/**
 * Conversation Atlas — overlay chrome (no data, no listeners; index.ts wires
 * those, mirroring the outline's panel.ts split).
 *
 * One full-viewport overlay under #cc-root: dot-grid stage + SVG canvas,
 * header, zoom controls, topic legend, hover tooltip, sliding detail panel,
 * and an empty-state note. All colors/fonts come from companion.css via
 * var(--cc-*); the only inline styles index.ts writes are geometry and the
 * documented custom-property bridges (grid scale, animation delays).
 */

import { ownedEl } from "@/ui/root";

export const ATLAS_ID = "cc-atlas";

const SVG_NS = "http://www.w3.org/2000/svg";

/** ownedEl's SVG sibling — namespaced create + attrs + owner stamp. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  owner: string,
  tag: K,
  attrs: Record<string, string> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  el.dataset["ccOwner"] = owner;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

export interface AtlasRefs {
  overlay: HTMLDivElement;
  stage: HTMLDivElement;
  svg: SVGSVGElement;
  world: SVGGElement;
  edgeLayer: SVGGElement;
  nodeLayer: SVGGElement;
  counts: HTMLSpanElement;
  zoomPct: HTMLSpanElement;
  resetBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  legend: HTMLDivElement;
  legendRows: HTMLDivElement;
  legendCount: HTMLDivElement;
  empty: HTMLDivElement;
  tip: HTMLDivElement;
  tipDot: HTMLSpanElement;
  tipTitle: HTMLSpanElement;
  tipPrev: HTMLDivElement;
  detail: HTMLElement;
  pillDot: HTMLSpanElement;
  pillLbl: HTMLSpanElement;
  detailClose: HTMLButtonElement;
  dKind: HTMLDivElement;
  dTitle: HTMLHeadingElement;
  dBody: HTMLParagraphElement;
  jumpBtn: HTMLButtonElement;
}

export function buildAtlasOverlay(owner: string): AtlasRefs {
  const overlay = ownedEl("div", {
    owner,
    className: "cc-hidden",
    attrs: {
      id: ATLAS_ID,
      role: "dialog",
      "aria-label": "Conversation Atlas",
      tabindex: "-1",
    },
  });

  // ---- stage + canvas ----------------------------------------------------
  const stage = ownedEl("div", { owner, className: "cc-atlas-stage" });
  const svg = svgEl(owner, "svg", { class: "cc-atlas-canvas" }, stage);
  const world = svgEl(owner, "g", {}, svg);
  const edgeLayer = svgEl(owner, "g", {}, world);
  const nodeLayer = svgEl(owner, "g", {}, world);
  overlay.appendChild(stage);

  // ---- header --------------------------------------------------------------
  const hdr = ownedEl("div", { owner, className: "cc-atlas-hdr" });
  const dot = ownedEl("span", { owner, className: "cc-atlas-hdr-dot" });
  const title = ownedEl("span", { owner, className: "cc-atlas-hdr-t" });
  title.append(
    ownedEl("b", { owner, text: "Conversation Atlas" }),
    " — spatial map of this chat",
  );
  const counts = ownedEl("span", { owner, className: "cc-atlas-hdr-n" });
  hdr.append(dot, title, counts);
  overlay.appendChild(hdr);

  // ---- controls (zoom % · reset · close) -----------------------------------
  const ctrl = ownedEl("div", { owner, className: "cc-atlas-ctrl" });
  const zoomPct = ownedEl("span", { owner, className: "cc-atlas-zoom", text: "100%" });
  const resetBtn = ownedEl("button", {
    owner,
    className: "cc-atlas-btn",
    text: "⌖ reset view",
    attrs: { type: "button", title: "Fit the whole map in view" },
  });
  const closeBtn = ownedEl("button", {
    owner,
    className: "cc-atlas-btn",
    text: "✕ close",
    attrs: { type: "button", title: "Close the atlas (Esc)", "aria-label": "Close the atlas" },
  });
  ctrl.append(zoomPct, resetBtn, closeBtn);
  overlay.appendChild(ctrl);

  // ---- legend -----------------------------------------------------------------
  const legend = ownedEl("div", { owner, className: "cc-atlas-legend" });
  legend.append(ownedEl("div", { owner, className: "cc-atlas-legend-t", text: "TOPICS" }));
  const legendRows = ownedEl("div", { owner });
  const legendCount = ownedEl("div", { owner, className: "cc-atlas-legend-n" });
  legend.append(legendRows, legendCount);
  overlay.appendChild(legend);

  // ---- hint + empty state ---------------------------------------------------
  overlay.appendChild(
    ownedEl("div", {
      owner,
      className: "cc-atlas-hint",
      text: "drag to pan · scroll to zoom · click a node for detail · Esc closes",
    }),
  );
  const empty = ownedEl("div", {
    owner,
    className: "cc-atlas-empty cc-hidden",
    text: "Nothing to map yet — ask something first.",
  });
  overlay.appendChild(empty);

  // ---- tooltip -------------------------------------------------------------------
  const tip = ownedEl("div", { owner, className: "cc-atlas-tip" });
  const tipHead = ownedEl("div", { owner, className: "cc-atlas-tip-t" });
  const tipDot = ownedEl("span", { owner, className: "cc-atlas-dot-sw" });
  const tipTitle = ownedEl("span", { owner });
  tipHead.append(tipDot, tipTitle);
  const tipPrev = ownedEl("div", { owner, className: "cc-atlas-tip-p" });
  tip.append(tipHead, tipPrev);
  overlay.appendChild(tip);

  // ---- detail panel -----------------------------------------------------------
  const detail = ownedEl("aside", { owner, className: "cc-atlas-detail" });
  const dh = ownedEl("div", { owner, className: "cc-atlas-detail-h" });
  const pill = ownedEl("span", { owner, className: "cc-atlas-pill" });
  const pillDot = ownedEl("span", { owner, className: "cc-atlas-dot-sw" });
  const pillLbl = ownedEl("span", { owner });
  pill.append(pillDot, pillLbl);
  const detailClose = ownedEl("button", {
    owner,
    className: "cc-atlas-detail-x",
    text: "×",
    attrs: { type: "button", title: "Close", "aria-label": "Close detail panel" },
  });
  dh.append(pill, detailClose);

  const db = ownedEl("div", { owner, className: "cc-atlas-detail-b" });
  const dKind = ownedEl("div", { owner, className: "cc-atlas-detail-k" });
  const dTitle = ownedEl("h2", { owner, className: "cc-atlas-detail-t" });
  const dBody = ownedEl("p", { owner, className: "cc-atlas-detail-p" });
  db.append(dKind, dTitle, dBody);

  const df = ownedEl("div", { owner, className: "cc-atlas-detail-f" });
  const jumpBtn = ownedEl("button", {
    owner,
    className: "cc-atlas-jump",
    text: "Jump to message →",
    attrs: { type: "button" },
  });
  df.appendChild(jumpBtn);

  detail.append(dh, db, df);
  overlay.appendChild(detail);

  return {
    overlay,
    stage,
    svg,
    world,
    edgeLayer,
    nodeLayer,
    counts,
    zoomPct,
    resetBtn,
    closeBtn,
    legend,
    legendRows,
    legendCount,
    empty,
    tip,
    tipDot,
    tipTitle,
    tipPrev,
    detail,
    pillDot,
    pillLbl,
    detailClose,
    dKind,
    dTitle,
    dBody,
    jumpBtn,
  };
}
