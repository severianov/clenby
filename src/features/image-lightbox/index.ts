/**
 * Image lightbox — Data & media. Conversation scope.
 *
 * Click any plain content image inside a thread message → open it full-screen
 * in an own-UI lightbox overlay under #cc-root: centered, max-viewport, dark
 * scrim, Esc / scrim-click / ✕ to close, zoom-to-fit vs actual-size toggle,
 * and a download button. Always automatic — no gear toggle (the affordance is
 * passive until an image is clicked).
 *
 * Own-UI safety:
 * - Attach is a maintenance sweep that only ADDS a reversible marker class
 *   (`cc-ilb-img`) to eligible images — cursor:zoom-in + a subtle hover ring
 *   come from companion.css; claude's DOM is otherwise untouched, and the
 *   class is stripped on teardown.
 * - Images that are wrapped in a link/button (claude's own uploaded-file
 *   previews open a native viewer; linked images navigate) are NEVER
 *   hijacked — the eligibility filter skips anything inside
 *   a / button / [role="button"], and tiny UI glyphs (< 40 px) are skipped.
 * - The lightbox shows OUR OWN <img> pointed at the same src — the original
 *   element is never moved or restyled.
 * - Click handling is delegated (pins pattern) and survives virtualization
 *   re-renders untouched.
 *
 * Download: same-origin fetch → Blob → anchor click (URL revoked after 5 s
 * and at unmount); when the fetch fails (cross-origin storage URL, network),
 * it degrades to opening the image in a new tab — never a broken button
 *.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl } from "@/ui/root";

const OWNER = "image-lightbox";

const SWEEP_MS = 900;
const FLASH_MS = 1400;
const URL_REVOKE_MS = 5000;
/** Below this rendered size (either axis) an image is a UI glyph, not content. */
const MIN_CONTENT_PX = 40;

// Lucide-style line icons — static, trusted markup (bundled constants).
const ICON_DOWNLOAD =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
const ICON_CLOSE =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const ICON_ZOOM =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6"/><path d="M8 11h6"/></svg>';
const ICON_CHECK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** Filename for the download anchor, derived from the image URL path. */
export function imageFilename(src: string): string {
  try {
    const path = new URL(src, location.href).pathname;
    const last = path.split("/").filter(Boolean).pop() ?? "";
    const clean = last.replace(/[^\w.-]+/g, "_");
    if (clean && /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i.test(clean)) return clean;
    if (clean) return `${clean}.png`;
  } catch {
    /* data:/blob:/malformed — fall through */
  }
  return "image.png";
}

let flashGen = 0;

export const imageLightbox: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    const pendingUrls = new Set<string>();

    // ---- eligibility ---------------------------------------------------------

    const eligible = (img: HTMLImageElement): boolean => {
      if (img.closest('a, button, [role="button"]')) return false; // never hijack
      if (img.closest("[data-cc-owner]")) return false; // companion UI
      if (ctx.selectors.closest("messageBlock", img) === null) return false; // thread only
      const r = img.getBoundingClientRect();
      if (r.width > 0 && (r.width < MIN_CONTENT_PX || r.height < MIN_CONTENT_PX)) return false;
      return Boolean(img.currentSrc || img.src);
    };

    /** Sweep: reversible marker class only — hover styling is pure CSS. */
    const sweep = (): void => {
      for (const img of ctx.selectors.queryAll<HTMLImageElement>("messageImage")) {
        img.classList.toggle("cc-ilb-img", eligible(img));
      }
    };

    // ---- lightbox (own UI under #cc-root) ------------------------------------

    interface Box {
      el: HTMLElement;
      returnFocus: HTMLElement | null;
    }
    let box: Box | null = null;

    const closeBox = (): void => {
      if (!box) return;
      box.el.remove();
      const back = box.returnFocus;
      box = null;
      if (back && back.isConnected) back.focus();
    };

    const openBox = (src: string, alt: string, trigger: HTMLElement | null): void => {
      closeBox();

      const el = ownedEl("div", {
        owner: OWNER,
        className: "cc-ilb-overlay",
        attrs: { role: "dialog", "aria-modal": "true", "aria-label": alt || "Image" },
      });

      const bar = ownedEl("div", { owner: OWNER, className: "cc-ilb-bar" });
      const mkBtn = (act: string, label: string, icon: string, toggle = false): HTMLButtonElement => {
        const b = ownedEl("button", {
          owner: OWNER,
          className: "cc-ilb-btn",
          attrs: {
            type: "button",
            title: label,
            "aria-label": label,
            "data-cc-act": act,
            ...(toggle ? { "aria-pressed": "false" } : {}),
          },
        });
        b.innerHTML = icon; // static, trusted markup
        return b;
      };
      bar.append(
        mkBtn("zoom", "Toggle fit / actual size", ICON_ZOOM, true),
        mkBtn("download", "Download image", ICON_DOWNLOAD),
        mkBtn("close", "Close (Esc)", ICON_CLOSE),
      );

      const stage = ownedEl("div", { owner: OWNER, className: "cc-ilb-stage" });
      const pic = ownedEl("img", {
        owner: OWNER,
        className: "cc-ilb-pic",
        attrs: { src, alt: alt || "" },
      });
      stage.append(pic);
      el.append(bar, stage);
      if (alt) {
        el.append(ownedEl("div", { owner: OWNER, className: "cc-ilb-caption", text: alt }));
      }
      ctx.root.append(el);

      box = { el, returnFocus: trigger };
      bar.querySelector<HTMLButtonElement>('[data-cc-act="close"]')?.focus();
    };

    // ---- actions -------------------------------------------------------------

    const flash = (btn: HTMLButtonElement, ok: boolean): void => {
      const prev = btn.innerHTML;
      btn.innerHTML = ICON_CHECK; // static, trusted markup
      btn.classList.add(ok ? "cc-ilb-done" : "cc-ilb-fail");
      const gen = String(++flashGen);
      btn.dataset["ccFlash"] = gen;
      ctx.setTimeout(() => {
        if (btn.dataset["ccFlash"] !== gen || !btn.isConnected) return;
        btn.innerHTML = prev;
        btn.classList.remove("cc-ilb-done", "cc-ilb-fail");
      }, FLASH_MS);
    };

    const download = async (src: string): Promise<boolean> => {
      try {
        const res = await fetch(src, { credentials: "include", signal: ctx.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        pendingUrls.add(url);
        const a = ownedEl("a", { owner: OWNER });
        a.href = url;
        a.download = imageFilename(src);
        a.click();
        ctx.setTimeout(() => {
          URL.revokeObjectURL(url);
          pendingUrls.delete(url);
        }, URL_REVOKE_MS);
        return true;
      } catch {
        if (ctx.signal.aborted) return false;
        // Degrade: at least show the full image in a tab (never a dead button).
        window.open(src, "_blank", "noopener");
        return false;
      }
    };

    // ---- delegated clicks ----------------------------------------------------

    ctx.listen(document, "click", (ev: MouseEvent) => {
      const target = ev.target instanceof Element ? ev.target : null;
      if (!target) return;

      // Lightbox chrome.
      const btn = target.closest<HTMLButtonElement>(".cc-ilb-btn");
      if (btn && btn.closest(`[data-cc-owner="${OWNER}"]`) && box) {
        ev.stopPropagation();
        const act = btn.dataset["ccAct"];
        if (act === "close") {
          closeBox();
        } else if (act === "zoom") {
          const actual = box.el.classList.toggle("cc-ilb-actual");
          btn.setAttribute("aria-pressed", actual ? "true" : "false");
        } else if (act === "download") {
          const src = box.el.querySelector<HTMLImageElement>(".cc-ilb-pic")?.src;
          if (src) {
            void download(src).then((ok) => {
              if (!ctx.signal.aborted && box) flash(btn, ok);
            });
          }
        }
        return;
      }

      // Scrim / stage background click closes; clicking the picture toggles zoom.
      if (box && target.closest(`[data-cc-owner="${OWNER}"]`)) {
        if (target.classList.contains("cc-ilb-pic")) {
          ev.stopPropagation();
          const actual = box.el.classList.toggle("cc-ilb-actual");
          box.el
            .querySelector('[data-cc-act="zoom"]')
            ?.setAttribute("aria-pressed", actual ? "true" : "false");
        } else if (target === box.el || target.classList.contains("cc-ilb-stage")) {
          ev.stopPropagation();
          closeBox();
        }
        return;
      }

      // A plain chat image → open the lightbox. Only a click ON the image
      // itself counts (an <img> has no children, so the event target is exact).
      const img = target instanceof HTMLImageElement ? target : null;
      if (img && eligible(img)) {
        ev.preventDefault();
        ev.stopPropagation();
        openBox(img.currentSrc || img.src, img.alt ?? "", img);
      }
    });

    // Esc closes (capture — before claude.ai's own handlers).
    ctx.listen(
      document,
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !box) return;
        ev.preventDefault();
        ev.stopPropagation();
        closeBox();
      },
      { capture: true },
    );

    // ---- maintenance sweep (pins pattern) ------------------------------------
    ctx.setInterval(sweep, SWEEP_MS);
    ctx.on("conversation:updated", sweep);
    sweep();

    // Teardown: marker classes stripped from claude's images, lightbox closed
    // (also caught by the runtime owner-sweep), blob URLs revoked.
    ctx.onCleanup(() => {
      closeBox();
      for (const img of document.querySelectorAll<HTMLElement>(".cc-ilb-img")) {
        img.classList.remove("cc-ilb-img");
      }
      for (const url of pendingUrls) URL.revokeObjectURL(url);
      pendingUrls.clear();
    });
  },
};
