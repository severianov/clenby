/**
 * The Clenby mark and wordmark — the one place the logo becomes elements.
 *
 * Geometry is copied verbatim from `brand/clenby-mark.svg`, which is the source
 * of truth for the shipped PNGs in `public/icon/`. If you change one, change
 * both — a logo that differs between the toolbar and the panel is worse than
 * no logo. `brand/README.md` records why the glyph is translated +3 on x.
 *
 * THE TILE STAYS INDIGO. It is not themed and it does not invert on dark: a
 * logo whose colour changes per preset is not a logo. The WORDMARK is themed
 * (var(--cc-text)) because it is type, not the mark. This is the one place in
 * the codebase where a hardcoded colour is correct — everything else must go
 * through var(--cc-*).
 *
 * SVG is built with createElementNS rather than ownedEl (which is typed for
 * HTML), matching the `lineIcon` idiom in header-cluster/gear-menu.ts. The
 * wrapper IS owner-stamped, so runtime disposal still sweeps the whole lockup.
 */

import { ownedEl } from "./root";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Brand indigo. Deliberately NOT Claude terracotta — see brand/README.md. */
const INDIGO = "#4F46E5";

/** The C arc: a 17px-radius circle with a ~100° aperture on the right. */
const ARC_D = "M42.93 18.98 A17 17 0 1 0 42.93 45.02";
/** The chevron sitting in the C's bowl. */
const CHEVRON_D = "M29.5 27 L34.5 32 L29.5 37";

function path(d: string, strokeWidth: string): SVGPathElement {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  p.setAttribute("stroke-width", strokeWidth);
  return p;
}

/**
 * The mark alone. Decorative by default — callers that need it announced
 * should label the surrounding control, not the svg.
 */
export function brandMark(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("cc-brand-mark");

  const tile = document.createElementNS(SVG_NS, "rect");
  tile.setAttribute("width", "64");
  tile.setAttribute("height", "64");
  tile.setAttribute("rx", "14");
  tile.setAttribute("fill", INDIGO);

  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", "translate(3 0)");
  g.setAttribute("fill", "none");
  g.setAttribute("stroke", "#FFFFFF");
  g.setAttribute("stroke-linecap", "round");
  g.setAttribute("stroke-linejoin", "round");
  g.append(path(ARC_D, "8"), path(CHEVRON_D, "4.6"));

  svg.append(tile, g);
  return svg;
}

export interface LockupOptions {
  owner: string;
}

/**
 * Mark + "clenby" as one horizontal object, per `brand/lockup.html`: the mark
 * at 1.09em so it optically matches the lowercase, 0.42em gap, −0.031em
 * tracking. All of that lives in `.cc-brand` in companion.css so the lockup
 * scales from a single font-size on the parent.
 */
export function brandLockup(opts: LockupOptions): HTMLElement {
  const wrap = ownedEl("span", { owner: opts.owner, className: "cc-brand" });
  wrap.append(
    brandMark(),
    ownedEl("span", { owner: opts.owner, className: "cc-brand-word", text: "clenby" }),
  );
  return wrap;
}
