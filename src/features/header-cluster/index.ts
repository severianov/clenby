/**
 * Header cluster — Tier 1 rider, session scope.
 * Hosts the Notes dropdown shell and the Tools (gear) menu (./gear-menu.ts).
 *
 * LANDMINES honored here:
 * - Two lucide-style SVG LINE icons (square-pen, settings), stroke
 *   currentColor — matches claude's icon style. NO emoji.
 * - Positioned NEXT TO the Share-button group WITHOUT entering its DOM:
 *   fixed positioning under #cc-root, re-tracked on a ctx.setInterval —
 *   inserting into the header breaks layout when the artifact panel opens.
 * - Right-aligned dropdowns; z-indexes come from companion.css classes
 *   (mirroring Z.headerCluster / Z.popover).
 *
 * MOUNT POINTS advertised for other features (features never import
 * features — discovery is by stable element id + bus events):
 * - `#cc-pop-notes-body`  — the notes feature renders its editor/list here.
 *   The popover shell (button `#cc-btn-notes`, right-aligned dropdown) is
 *   ours; notes may programmatically open it by clicking `#cc-btn-notes`.
 *   On every open we emit bus `ui:notes-open` with this container — the
 *   notes feature subscribes and (re)mounts its panel into it.
 * - `#cc-gear-export-slot` — the export feature's controls (slot built inside
 *   ./gear-menu.ts). On every gear-menu open we emit bus `ui:export-open`
 *   with the slot — the export feature subscribes and (re)mounts its rows.
 * - The composer-inline group `#cc-composer-grp` (with `#cc-undo-inline` /
 *   `#cc-usage-inline`, ordered [undo][usage] before the voice button) is
 *   NOT ours: the undo-send + usage features own, create and place it
 *   themselves (their shared contract). We deliberately create nothing there.
 */

import { browser } from "wxt/browser";
import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl, setGeometry } from "@/ui/root";
import { buildGearMenu, COMMAND_ICON_PATH } from "./gear-menu";
import { ariaKeyShortcuts, chordOf, chordText } from "@/shared/keymap";

const OWNER = "header-cluster";

const TRACK_MS = 500;
/** Gap between the cluster and the Share button's PARENT group. */
const CLUSTER_GAP_PX = 10;
const POPOVER_GAP_PX = 8;
/** Pull-left: dropdowns right-align at `innerWidth − r.right − 40`
 *  so they clear the window-edge controls. */
const POPOVER_PULL_LEFT_PX = 40;
const ICON_BTN_PX = 34;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide-style line icon (stroke: currentColor). `shapes` are [tag, attrs]. */
function lineIcon(shapes: ReadonlyArray<readonly [string, Record<string, string>]>): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

/** lucide `square-pen` — the notes button. */
function squarePenIcon(): SVGSVGElement {
  return lineIcon([
    ["path", { d: "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }],
    [
      "path",
      {
        d: "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z",
      },
    ],
  ]);
}

/** lucide `command` — the command-palette button (path shared with the gear
 *  menu's Palette tile and shortcuts row). */
function commandIcon(): SVGSVGElement {
  return lineIcon([["path", { d: COMMAND_ICON_PATH }]]);
}

/** lucide `settings` — the gear button. */
function settingsIcon(): SVGSVGElement {
  return lineIcon([
    [
      "path",
      {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      },
    ],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ]);
}

export const headerCluster: FeatureModule = {
  id: "header-cluster",
  tier: 1,
  scope: "session",

  mount(ctx: FeatureContext) {
    // ---- the floating icon pair ------------------------------------------------
    const cluster = ownedEl("div", {
      owner: OWNER,
      className: "cc-hidden",
      attrs: { id: "cc-cluster" },
    });

    const iconBtn = (id: string, title: string, icon: SVGSVGElement): HTMLButtonElement => {
      const b = ownedEl("button", {
        owner: OWNER,
        className: "cc-iconbtn",
        attrs: { id, type: "button", title, "aria-label": title, "aria-haspopup": "true" },
      });
      b.appendChild(icon);
      return b;
    };

    const notesBtn = iconBtn("cc-btn-notes", "Chat notes", squarePenIcon());
    const gearBtn = iconBtn("cc-btn-gear", "Clenby — themes & tools", settingsIcon());
    // `iconBtn` writes the same string to title AND aria-label, so the clean
    // spoken name needs a post-hoc override: chord in `title`, plain name in
    // `aria-label`, chord in the attribute that exists for it.
    const paletteChord = chordOf("palette");
    const paletteBtn = iconBtn(
      "cc-btn-palette",
      `Command palette (${chordText(paletteChord)})`,
      commandIcon(),
    );
    paletteBtn.setAttribute("aria-label", "Command palette");
    paletteBtn.setAttribute("aria-keyshortcuts", ariaKeyShortcuts(paletteChord));
    paletteBtn.removeAttribute("aria-haspopup"); // not a dropdown — an overlay toggle
    cluster.append(paletteBtn, notesBtn, gearBtn);
    ctx.root.appendChild(cluster);

    // The palette feature owns the overlay; discovery via the bus (no
    // feature imports).
    ctx.listen(paletteBtn, "click", (ev) => {
      ev.stopPropagation();
      ctx.bus.emit("ui:palette-toggle", {});
    });

    // ---- popovers ---------------------------------------------------------------
    const popNotes = ownedEl("div", {
      owner: OWNER,
      className: "cc-popover cc-pop cc-hidden",
      attrs: { id: "cc-pop-notes" },
    });
    // The NOTES FEATURE is the single owner of the panel header ("Notes" +
    // mono scope line) — it renders one into the body on every `ui:notes-open`
    // (list AND editor views draw their own). The shell renders NO header of
    // its own; ensureNotesFallback below covers the no-conversation case.
    // (Fixes the doubled-header bug: shell title + feature title used to
    // stack in this popover.)
    const notesBody = ownedEl("div", { owner: OWNER, attrs: { id: "cc-pop-notes-body" } });
    popNotes.append(notesBody);

    const popTools = ownedEl("div", {
      owner: OWNER,
      className: "cc-popover cc-pop cc-hidden",
      attrs: { id: "cc-pop-tools" },
    });
    popTools.appendChild(buildGearMenu(ctx));

    ctx.root.append(popNotes, popTools);

    // ---- open/close logic ----------------------------------------------------------
    const pairs: ReadonlyArray<readonly [HTMLButtonElement, HTMLDivElement]> = [
      [notesBtn, popNotes],
      [gearBtn, popTools],
    ];

    const positionPopover = (btn: HTMLElement, pop: HTMLElement): void => {
      const r = btn.getBoundingClientRect();
      // Right-aligned dropdown, pulled 40px further left than the button's
      // right edge (clears the header's edge controls).
      setGeometry(pop, {
        top: Math.round(r.bottom + POPOVER_GAP_PX),
        right: Math.max(8, Math.round(window.innerWidth - r.right - POPOVER_PULL_LEFT_PX)),
      });
    };

    const closeAll = (): void => {
      for (const [btn, pop] of pairs) {
        pop.classList.add("cc-hidden");
        btn.removeAttribute("data-open");
      }
    };

    /** Placeholder when no feature filled a popover slot (e.g. outside a
     *  conversation the notes/export features aren't mounted, so the
     *  `ui:*-open` emit below finds no subscriber). */
    const ensureFallback = (container: HTMLElement, text: string): void => {
      if (container.childElementCount === 0) {
        container.appendChild(ownedEl("div", { owner: OWNER, className: "cc-faint", text }));
      }
    };

    /** Notes fallback keeps the panel's single header (same classes the notes
     *  feature uses) so the popover looks whole outside a conversation. */
    const ensureNotesFallback = (): void => {
      if (notesBody.childElementCount > 0) return;
      const head = ownedEl("div", { owner: OWNER, className: "cc-notes-head" });
      head.append(
        ownedEl("span", { owner: OWNER, className: "cc-notes-title", text: "Notes" }),
        ownedEl("span", {
          owner: OWNER,
          className: "cc-notes-scope",
          text: "this chat · markdown",
        }),
      );
      notesBody.append(
        head,
        ownedEl("div", {
          owner: OWNER,
          className: "cc-notes-empty",
          text: "Open a conversation to take notes.",
        }),
      );
    };

    const toggle = (btn: HTMLButtonElement, pop: HTMLDivElement): void => {
      const wasOpen = !pop.classList.contains("cc-hidden");
      closeAll();
      if (wasOpen) return;
      positionPopover(btn, pop);
      pop.classList.remove("cc-hidden");
      btn.setAttribute("data-open", "1");

      // Hand the mount slots to their owning features on EVERY open (the
      // emit is synchronous; the features re-render idempotently).
      if (pop === popNotes) {
        ctx.bus.emit("ui:notes-open", { container: notesBody });
        ensureNotesFallback();
      } else if (pop === popTools) {
        const exportSlot = pop.querySelector<HTMLElement>("#cc-gear-export-slot");
        if (exportSlot) {
          ctx.bus.emit("ui:export-open", { container: exportSlot });
          ensureFallback(exportSlot, "Open a conversation to export");
        }
      }

      const field = pop.querySelector<HTMLElement>("input, textarea");
      if (field) ctx.setTimeout(() => field.focus(), 50);
    };

    for (const [btn, pop] of pairs) {
      ctx.listen(btn, "click", (ev) => {
        ev.stopPropagation();
        toggle(btn, pop);
      });
    }

    // Toolbar-icon relay: with the popup page removed, the background turns
    // an extension-icon click on a claude.ai tab into this runtime message —
    // open the gear menu (THE settings surface). Without a header anchor
    // (cluster hidden — home screens without a Share button) dock the
    // popover top-right so the menu is still reachable. Not a ctx.listen
    // target (runtime.onMessage isn't an EventTarget) — cleaned up manually.
    const onRuntimeMessage = (message: unknown): undefined => {
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { type?: unknown }).type !== "cc:open-settings"
      ) {
        return undefined;
      }
      if (!popTools.classList.contains("cc-hidden")) return undefined; // already open
      if (cluster.classList.contains("cc-hidden")) {
        closeAll();
        setGeometry(popTools, { top: 64, right: 16 });
        popTools.classList.remove("cc-hidden");
        const exportSlot = popTools.querySelector<HTMLElement>("#cc-gear-export-slot");
        if (exportSlot) {
          ctx.bus.emit("ui:export-open", { container: exportSlot });
          ensureFallback(exportSlot, "Open a conversation to export");
        }
      } else {
        toggle(gearBtn, popTools);
      }
      return undefined;
    };
    // Composer-chip shortcut (bus, cross-feature): open the gear menu, then
    // scroll to and flash the Claude Code card so the user lands EXACTLY on
    // the thing they clicked for — not at the top of a long panel.
    // The palette overlays this menu — get out of its way whichever entry
    // point opened it (⌘ button, gear Palette tile, gear shortcuts row).
    ctx.on("ui:palette-toggle", () => closeAll());
    ctx.on("ui:palette-shortcuts", () => closeAll());
    ctx.on("ui:bridge-setup", () => {
      if (popTools.classList.contains("cc-hidden")) {
        if (cluster.classList.contains("cc-hidden")) {
          closeAll();
          setGeometry(popTools, { top: 64, right: 16 });
          popTools.classList.remove("cc-hidden");
        } else {
          toggle(gearBtn, popTools);
        }
      }
      ctx.setTimeout(() => {
        const zoneEl = popTools.querySelector<HTMLElement>("#cc-gear-ccb");
        if (!zoneEl) return;
        zoneEl.scrollIntoView({ block: "start", behavior: "smooth" });
        zoneEl.classList.remove("cc-zone-flash");
        void zoneEl.offsetWidth; // restart the animation
        zoneEl.classList.add("cc-zone-flash");
        ctx.setTimeout(() => zoneEl.classList.remove("cc-zone-flash"), 1700);
      }, 80);
    });

    try {
      browser.runtime.onMessage.addListener(onRuntimeMessage);
      ctx.onCleanup(() => browser.runtime.onMessage.removeListener(onRuntimeMessage));
    } catch {
      // Messaging unavailable (exotic embed) — the gear button still works.
    }

    ctx.listen(document, "mousedown", (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      if (t.closest("#cc-cluster") || t.closest("#cc-pop-notes") || t.closest("#cc-pop-tools")) {
        return;
      }
      closeAll();
    });
    ctx.listen(document, "keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Escape") closeAll();
    });

    // ---- Share-group tracking (track, don't enter) ------------------------------
    let shareBtn: HTMLElement | null = null;

    const findShareButton = (): HTMLElement | null => {
      if (shareBtn?.isConnected && shareBtn.getBoundingClientRect().width > 0) return shareBtn;
      shareBtn = null;
      // Generic tag scan + text/aria heuristics (no claude-specific selector
      // exists for this button; core/selectors.ts owns structural selectors).
      for (const b of document.querySelectorAll<HTMLElement>("button")) {
        const aria = b.getAttribute("aria-label") ?? "";
        const text = (b.textContent ?? "").trim();
        if (text === "Share" || /^share\b/i.test(aria)) {
          if (b.getBoundingClientRect().width > 0) {
            shareBtn = b;
            break;
          }
        }
      }
      return shareBtn;
    };

    const trackCluster = (): void => {
      const share = findShareButton();
      if (!share) {
        if (!cluster.classList.contains("cc-hidden")) {
          cluster.classList.add("cc-hidden");
          closeAll();
        }
        return;
      }
      // Anchor to the Share button's PARENT group rect, not the button itself
      // — the
      // button shares its parent with sibling header controls, and docking to
      // the button alone can overlap them.
      const r = (share.parentElement ?? share).getBoundingClientRect();
      cluster.classList.remove("cc-hidden");
      const width = cluster.offsetWidth || ICON_BTN_PX * 3 + 4;
      setGeometry(cluster, {
        left: Math.round(r.left - width - CLUSTER_GAP_PX),
        top: Math.round(r.top + (r.height - ICON_BTN_PX) / 2),
      });
      // Keep an open dropdown glued to its button while the header moves.
      for (const [btn, pop] of pairs) {
        if (!pop.classList.contains("cc-hidden")) positionPopover(btn, pop);
      }
    };

    ctx.setInterval(trackCluster, TRACK_MS);
    trackCluster();
  },
};
