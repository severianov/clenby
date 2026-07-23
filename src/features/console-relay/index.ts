/**
 * Console Relay — Tier 3, session scope. The differentiator.
 *
 * Verified full loop: capture → badge → composer insert → reset.
 *
 * How it works:
 * - Artifact previews are same-origin-readable iframes (usually `srcdoc`,
 *   sometimes property-set or blob:). A 1 s ctx poll scans ALL iframes
 *   (selectors "artifactIframe" = `iframe`) and
 *   hooks each readable contentWindow — cross-origin frames are skipped by
 *   hook()'s try/catch: `error` + `unhandledrejection` listeners plus a
 *   console.error wrap (messages + stacks).
 * - Captured errors are DE-DUPED (type+message+line key, ×N counter) and
 *   surfaced as a red "⚠ N artifact errors — send to Claude" badge docked to
 *   the artifact panel's TOP-RIGHT (viewport top-right fallback when the
 *   iframe has no usable on-screen box).
 * - Click → errors formatted as a markdown message → ctx.composer.insertText
 *   → buffer reset. Insert failure keeps the buffer (degrade quietly).
 * - RE-HOOK ON ARTIFACT VERSION CHANGE: hooks are keyed per contentDocument
 *   (WeakMap iframe → Document). A version switch / srcdoc rewrite creates a
 *   new document, so the poll re-hooks automatically; the old hooks die with
 *   the old window.
 * - Every hook goes through ctx (ctx.listen on the iframe's window; the
 *   console.error unwrap via ctx.onCleanup) so teardown is guaranteed.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl, setGeometry } from "@/ui/root";

const ID = "console-relay";

/** Max distinct (deduped) errors kept; oldest dropped beyond this. */
const MAX_ERRORS = 50;
/** Per-message length cap. */
const MSG_CAP = 300;
/** Stack lines included per error in the relayed markdown. */
const STACK_LINES = 4;
const POLL_MS = 1000;

interface CapturedError {
  type: string;
  msg: string;
  stack?: string;
  line?: number;
  count: number;
}

/** Duck-typed Error reader — `instanceof Error` FAILS across iframe realms. */
function errLike(v: unknown): { message?: unknown; stack?: unknown } | null {
  return typeof v === "object" && v !== null
    ? (v as { message?: unknown; stack?: unknown })
    : null;
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function fmtArg(a: unknown): string {
  if (typeof a === "string") return a;
  try {
    return typeof a === "object" && a !== null ? JSON.stringify(a) : String(a);
  } catch {
    try {
      return String(a);
    } catch {
      return "[unserializable]";
    }
  }
}

export const consoleRelay: FeatureModule = {
  id: ID,
  tier: 3,
  scope: "session",

  mount(ctx: FeatureContext) {
    const errors: CapturedError[] = [];
    /** iframe → the contentDocument we hooked. A new document (artifact
     *  version change, srcdoc rewrite) no longer matches → re-hook. */
    const hookedDocs = new WeakMap<HTMLIFrameElement, Document>();

    // ---- badge UI (top-level → under #cc-root only) ----
    const badge = ownedEl("button", {
      owner: ID,
      className: "cc-console-badge",
      attrs: { id: "cc-console-badge", type: "button", "aria-label": "Send artifact errors to Claude" },
    });
    const icon = ownedEl("span", { owner: ID, className: "cc-console-badge-icon", text: "⚠" });
    const label = ownedEl("span", { owner: ID });
    badge.append(icon, label);
    badge.style.display = "none";
    ctx.root.appendChild(badge);
    ctx.onCleanup(() => badge.remove());

    const totalCount = (): number => errors.reduce((a, e) => a + e.count, 0);

    /** The hooked iframe with the largest on-screen box (the scan now covers
     *  ALL iframes, so tiny/offscreen helper frames must not win the dock). */
    const hookedIframe = (): HTMLIFrameElement | null => {
      let best: HTMLIFrameElement | null = null;
      let bestArea = 0;
      for (const f of ctx.selectors.queryAll<HTMLIFrameElement>("artifactIframe")) {
        if (!hookedDocs.has(f)) continue;
        const r = f.getBoundingClientRect();
        const area = r.width * r.height;
        if (best === null || area > bestArea) {
          best = f;
          bestArea = area;
        }
      }
      return best;
    };

    /** Dock to the artifact panel's top-right; viewport top-right fallback
     *  when the iframe has no usable on-screen box (polish debt, fixed). */
    const positionBadge = (): void => {
      const rect = hookedIframe()?.getBoundingClientRect();
      const w = badge.offsetWidth || 230;
      if (rect && rect.width > 40 && rect.height > 40) {
        setGeometry(badge, {
          left: Math.max(8, rect.right - w - 12),
          top: Math.max(8, rect.top + 10),
        });
      } else {
        setGeometry(badge, { left: Math.max(8, window.innerWidth - w - 24), top: 70 });
      }
    };

    const updateBadge = (): void => {
      const n = totalCount();
      if (n === 0) {
        badge.style.display = "none";
        return;
      }
      label.textContent = `${n} artifact error${n === 1 ? "" : "s"} — send to Claude`;
      badge.style.display = "flex";
      positionBadge();
    };

    // ---- capture (deduped) ----
    const push = (type: string, msg: unknown, stack?: string, line?: number): void => {
      const m = String(msg).slice(0, MSG_CAP);
      const existing = errors.find((e) => e.type === type && e.msg === m && e.line === line);
      if (existing) {
        existing.count++;
      } else {
        if (errors.length >= MAX_ERRORS) errors.shift();
        const entry: CapturedError = { type, msg: m, count: 1 };
        if (stack) entry.stack = stack;
        if (line !== undefined) entry.line = line;
        errors.push(entry);
      }
      updateBadge();
    };

    // ---- relay to composer ----
    const fmtErr = (e: CapturedError): string => {
      let s = `[${e.type}] ${e.msg}`;
      if (e.count > 1) s += ` (×${e.count})`;
      if (e.stack) s += "\n" + e.stack.split("\n").slice(0, STACK_LINES).join("\n");
      if (e.line !== undefined) s += ` (line ${e.line})`;
      return s;
    };

    ctx.listen(badge, "click", () => {
      const n = totalCount();
      if (n === 0) return;
      const msg =
        `My artifact threw ${n} error${n === 1 ? "" : "s"}:\n\n` +
        "```\n" +
        errors.map(fmtErr).join("\n\n") +
        "\n```\n\nCan you fix it?";
      if (ctx.composer.insertText(msg)) {
        errors.length = 0;
        updateBadge();
      } else {
        // Composer missing / insertion failed: keep the buffer, stay quiet.
        console.debug("[cc] console-relay: composer insert failed, keeping errors");
      }
    });

    // ---- iframe hooking ----
    const hook = (frame: HTMLIFrameElement): void => {
      let win: (Window & { console?: Console }) | null;
      let doc: Document | null;
      try {
        win = frame.contentWindow as (Window & { console?: Console }) | null;
        doc = frame.contentDocument;
      } catch {
        return; // cross-origin — not a readable artifact preview
      }
      if (!win || !doc) return;
      if (hookedDocs.get(frame) === doc) return; // this document is already hooked
      hookedDocs.set(frame, doc);

      ctx.listen(win, "error", (ev: ErrorEvent) => {
        const err = errLike(ev.error);
        push(
          "error",
          ev.message || strOrUndef(err?.message) || "script error",
          strOrUndef(err?.stack),
          typeof ev.lineno === "number" && ev.lineno > 0 ? ev.lineno : undefined,
        );
      });
      ctx.listen(win, "unhandledrejection", (ev: Event) => {
        const reason: unknown = (ev as PromiseRejectionEvent).reason;
        const err = errLike(reason);
        push("promise", strOrUndef(err?.message) ?? String(reason), strOrUndef(err?.stack));
      });
      try {
        const con = win.console;
        if (con && typeof con.error === "function") {
          const orig = con.error.bind(con);
          con.error = (...args: unknown[]) => {
            push("console.error", args.map(fmtArg).join(" "));
            orig(...args);
          };
          ctx.onCleanup(() => {
            try {
              con.error = orig;
            } catch {
              // iframe window already gone — nothing to restore
            }
          });
        }
      } catch {
        // console not reachable — the window listeners above still work
      }
    };

    const scan = (): void => {
      for (const f of ctx.selectors.queryAll<HTMLIFrameElement>("artifactIframe")) hook(f);
      // Keep the badge docked while the artifact panel moves/resizes.
      if (errors.length > 0) positionBadge();
    };
    ctx.setInterval(scan, POLL_MS);
    scan();

    // Errors belong to the conversation whose artifact threw them.
    ctx.on("nav:conversation-changed", () => {
      errors.length = 0;
      updateBadge();
    });
  },
};
