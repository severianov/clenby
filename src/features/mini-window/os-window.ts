/**
 * Window plumbing for the mini-window feature.
 *
 * WINDOW MODEL (the original design, restored 2026-07-22): pop-out targets
 * THE Document Picture-in-Picture window — the web platform's only true
 * always-on-top surface. It floats above every tab and OS window (visible
 * across all tabs and while other apps are focused), has no browser chrome
 * beyond a slim native strip, and is deliberately compact. The platform
 * allows exactly ONE Document PiP window per browser, so multiple popped-out
 * answers are hosted as CARDS in that one window's scrollable column
 * (index.ts owns the cards; {@link prepareWindowDocument} builds the shell).
 *
 * {@link requestPipWindow} must be reached SYNCHRONOUSLY from the pop-out
 * click in the page (requestWindow consumes the transient user gesture — an
 * await first would burn it). The PiP window dies with its opener tab and
 * when the browser opens a different Document PiP; index.ts listens for
 * pagehide and rebuilds state accordingly.
 *
 * Firefox has no Document PiP API (2026) — {@link pipSupported} gates the
 * path, and pop-out degrades to one small `window.open` popup per answer
 * ({@link openFallbackWindow}): not always-on-top, but real, arrangeable
 * windows that need no permissions.
 *
 * Every spawned window (PiP and popup alike) is a fresh, style-less document:
 * {@link prepareWindowDocument} copies the injected companion stylesheet
 * (#cc-companion) into it and snapshots the CURRENT computed --cc-* token
 * values (the theme compiler writes them on the main document's root, which
 * the copied sheet alone can't see).
 */

interface DocumentPictureInPictureOptions {
  width?: number;
  height?: number;
  disallowReturnToOpener?: boolean;
}

interface DocumentPictureInPictureHost {
  requestWindow(options?: DocumentPictureInPictureOptions): Promise<Window>;
  readonly window: Window | null;
}

declare global {
  interface Window {
    readonly documentPictureInPicture?: DocumentPictureInPictureHost;
  }
}

/** Every companion token the mini-window CSS can reference — snapshotted
 *  into each spawned window's document at open time. */
const WIN_TOKENS = [
  "--cc-bg",
  "--cc-surface",
  "--cc-surface-raised",
  "--cc-surface-raised-2",
  "--cc-text",
  "--cc-text-muted",
  "--cc-text-faint",
  "--cc-border",
  "--cc-accent",
  "--cc-danger",
  "--cc-gold",
  "--cc-ok",
  "--cc-shadow",
  "--cc-mono",
  "--cc-sans",
] as const;

export function pipSupported(): boolean {
  return typeof window.documentPictureInPicture?.requestWindow === "function";
}

/** Open THE Document PiP window (always-on-top, compact). Must be reached
 *  synchronously from the pop-out click — the click IS the gesture. Returns
 *  null when unavailable/denied; the caller degrades quietly. */
export async function requestPipWindow(width: number, height: number): Promise<Window | null> {
  const host = window.documentPictureInPicture;
  if (!host) return null;
  try {
    return await host.requestWindow({ width, height });
  } catch {
    return null; // no user gesture / policy denial — quietly absent
  }
}

/** Firefox fallback: one individual popup per answer (`cascade` staggers
 *  spawn positions so consecutive windows don't stack exactly). Must also be
 *  reached synchronously from the click (the gesture lets the popup
 *  through); null when blocked. */
export function openFallbackWindow(width: number, height: number, cascade: number): Window | null {
  const left = Math.max(0, Math.round(window.screenX + 90 + cascade));
  const top = Math.max(0, Math.round(window.screenY + 90 + cascade));
  try {
    return window.open(
      "about:blank",
      "_blank",
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
  } catch {
    return null;
  }
}

/**
 * Style a fresh spawned window's document: companion CSS + token snapshot +
 * the shell class ("cc-pip" for the PiP card column, "cc-win" for a fallback
 * popup). Returns the element the caller adopts `.cc-mw` cards into. No
 * data-cc-owner bookkeeping is needed: teardown is `win.close()`, which
 * destroys the whole document.
 */
export function prepareWindowDocument(
  win: Window,
  title: string,
  kind: "pip" | "win",
): HTMLElement {
  const doc = win.document;
  doc.title = title;

  const style = doc.createElement("style");
  const companionCss = document.getElementById("cc-companion")?.textContent ?? "";
  // :root (0,1,0) outranks the copied sheet's bare `html` fallbacks (0,0,1),
  // so the snapshot always wins — the window matches the active theme.
  style.textContent = `${companionCss}\n${tokenSnapshotCss()}`;
  doc.head.appendChild(style);

  doc.body.className = kind === "pip" ? "cc-pip" : "cc-win";
  if (kind === "win") return doc.body;

  // PiP shell: the scrollable card column (cards keep their own titlebars —
  // no extra header row; the PiP's slim native strip already identifies it).
  const host = doc.createElement("div");
  host.className = "cc-pip-host";
  doc.body.appendChild(host);
  return host;
}

function tokenSnapshotCss(): string {
  const cs = getComputedStyle(document.documentElement);
  const decls: string[] = [];
  for (const token of WIN_TOKENS) {
    const value = cs.getPropertyValue(token).trim();
    if (value) decls.push(`${token}: ${value};`);
  }
  return `:root { ${decls.join(" ")} }`;
}
