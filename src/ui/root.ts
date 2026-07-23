/**
 * The single #cc-root container — the codebase's ONLY `document.body.appendChild`
 * call. All top-level companion UI mounts under it.
 *
 * Also home of the two DOM helpers every feature uses:
 * - {@link ownedEl} — element builder that stamps `data-cc-owner`, so
 *   runtime disposal can sweep a feature's nodes even if it forgets one.
 * - {@link setGeometry} — the only sanctioned inline-style writer: geometry
 *   only (drag positions, computed sizes). Inline colors/fonts are a defect;
 *   visual styling comes from companion.css via var(--cc-*).
 */

export const ROOT_ID = "cc-root";

export function ensureRoot(): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  return root;
}

export interface OwnedElOptions {
  /** The owning feature's id — stamped as data-cc-owner. */
  owner: string;
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
}

export function ownedEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: OwnedElOptions,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.dataset["ccOwner"] = opts.owner;
  if (opts.className) el.className = opts.className;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
  }
  return el;
}

export interface Geometry {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  width?: number;
  height?: number;
  transform?: string;
}

/** Geometry-only inline styles (px units). Anything visual belongs in CSS. */
export function setGeometry(el: HTMLElement, geo: Geometry): void {
  if (geo.left !== undefined) el.style.left = `${geo.left}px`;
  if (geo.top !== undefined) el.style.top = `${geo.top}px`;
  if (geo.right !== undefined) el.style.right = `${geo.right}px`;
  if (geo.bottom !== undefined) el.style.bottom = `${geo.bottom}px`;
  if (geo.width !== undefined) el.style.width = `${geo.width}px`;
  if (geo.height !== undefined) el.style.height = `${geo.height}px`;
  if (geo.transform !== undefined) el.style.transform = geo.transform;
}
