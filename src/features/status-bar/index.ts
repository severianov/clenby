/**
 * Status bar v12 — Tier 1, session scope.
 *
 * Three lines:
 *  L1 thinking words (glyph ✢✳✴✻✽ + rotating gerund + elapsed + ⚒ tokens +
 *     "esc to interrupt") while generating, else "● idle"
 *  R1 context gauge (▰▱ blocks, full-conversation token estimate / 200k)
 *  L2 draft counter (✎ N ch · N w · ~N tok — absorbed the retired counter
 *     chip's counts 2026-07-21) + secret guard (inline red warning;
 *     gated on settings.secretGuardOn — default ON, live via storage)
 *  R2 "N msgs · N turns · duration"
 *  L3 chat id (click to copy the chat link)
 *  R3 sponsor slot (./sponsor.ts split-flap board)
 *
 * LANDMINES honored here:
 * - The bar is a FLOATING PILL above the composer (positioned off the
 *   composer rect, re-tracked every tick):
 *   position:fixed under #cc-root, left/width copied from the composer's
 *   rounded container rect (ctx.composer.container()), top = rect.top −
 *   barHeight − 8px gap. Its surface is the dedicated --cc-bar-bg token — an
 *   elevated surface distinct from the composer on every theme (the in-flow
 *   first-child anchoring blended the bar into the composer and was reverted).
 * - Streaming state comes from ctx.on("generation:*") ONLY — the core
 *   detector owns stop-button + growth; this feature only renders. Token
 *   counter accumulates `generation:tick` charsDelta (chars/4).
 * - Context gauge = chars/4 over the FULL API conversation
 *   (ctx.conversation.current(), shared/text.estimateTokens).
 * - Secret guard: inline red text in line 2 (floating strip was REJECTED);
 *   detection is pure (./secret-guard.ts); clears with the draft.
 * - Chat duration = first→last message createdAt (shared/time.durationBetween).
 * - claude's scroll-to-bottom arrow shifts up via `html.cc-has-status`
 *   (companion.css); the class is toggled here and removed on cleanup.
 * - Sponsor slot: bundled static data, createElement/textContent only.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl, setGeometry } from "@/ui/root";
import { estimateTokens, wordCount } from "@/shared/text";
import { durationBetween } from "@/shared/time";
import { detectSecrets } from "./secret-guard";
import { attachSponsorSlot } from "./sponsor";

const OWNER = "status-bar";

/** Rotating thinking gerunds. */
const WORDS = [
  "Pondering",
  "Simmering",
  "Percolating",
  "Reticulating",
  "Marinating",
  "Cogitating",
  "Noodling",
  "Conjuring",
  "Clauding",
  "Vibing",
  "Herding",
  "Finagling",
  "Schlepping",
  "Moseying",
  "Transmuting",
  "Brewing",
  "Crunching",
  "Deliberating",
  "Manifesting",
  "Smooshing",
] as const;

/** Thinking glyph animation frames. */
const GLYPHS = ["✢", "✳", "✴", "✻", "✽"] as const;

const TICK_MS = 500;
const GLYPH_MS = 250;
const WORD_ROTATE_MS = 4000;
const CONTEXT_LIMIT_TOKENS = 200_000;
const GAUGE_BLOCKS = 10;
const COPIED_FLASH_MS = 1500;
/** Gap between the floating pill and the composer's top edge. */
const BAR_GAP_PX = 8;
/** Bar height fallback (72px, floated 8px above the composer). */
const BAR_FALLBACK_HEIGHT_PX = 72;

export const statusBar: FeatureModule = {
  id: "status-bar",
  tier: 1,
  scope: "session",

  mount(ctx: FeatureContext) {
    // ---- DOM ---------------------------------------------------------------
    const bar = ownedEl("div", { owner: OWNER, attrs: { id: "cc-status" } });

    const row = (extraClass: string): HTMLDivElement =>
      ownedEl("div", { owner: OWNER, className: `cc-status-row ${extraClass}`.trim() });
    const seg = (id: string, className = ""): HTMLSpanElement =>
      ownedEl("span", {
        owner: OWNER,
        className: `cc-status-seg ${className}`.trim(),
        attrs: { id },
      });

    const l1 = seg("cc-l1");
    const r1 = seg("cc-r1", "cc-muted");
    const l2 = seg("cc-l2");
    const r2 = seg("cc-r2", "cc-faint");
    const l3 = seg("cc-l3");
    const ad = ownedEl("span", { owner: OWNER, className: "cc-ad", attrs: { id: "cc-ad" } });

    const row1 = row("");
    row1.append(l1, r1);
    const row2 = row("cc-status-row2");
    row2.append(l2, r2);
    const row3 = row("cc-status-row3");
    row3.append(l3, ad);
    bar.append(row1, row2, row3);
    // Top-level floating UI mounts under #cc-root; hidden until the
    // first anchor() finds the composer.
    bar.classList.add("cc-hidden");
    ctx.root.appendChild(bar);

    attachSponsorSlot(ad, ctx);

    // ---- state ---------------------------------------------------------------
    let working = false;
    let workStart = 0;
    let streamedChars = 0;
    let glyphIndex = 0;
    let copiedFlash = false;
    // Secret detection (gear "Secret detection" switch + palette action;
    // default ON). When off, the draft is never scanned and no warning shows.
    let secretGuardOn = true;

    void ctx.storage.getSettings().then((s) => {
      if (ctx.signal.aborted) return;
      secretGuardOn = s.secretGuardOn;
    });
    ctx.onCleanup(
      ctx.storage.onSettingsChanged((s) => {
        secretGuardOn = s.secretGuardOn;
      }),
    );

    // ---- generation events (the ONE detector — we only render) ---------------
    ctx.on("generation:start", () => {
      working = true;
      workStart = Date.now();
      streamedChars = 0;
      renderLine1();
    });
    ctx.on("generation:tick", ({ charsDelta }) => {
      streamedChars += Math.max(0, charsDelta);
    });
    ctx.on("generation:end", () => {
      working = false;
      renderLine1();
    });

    // ---- line renderers -------------------------------------------------------
    const renderLine1 = (): void => {
      l1.replaceChildren();
      if (working) {
        const now = Date.now();
        const word = WORDS[Math.floor((now - workStart) / WORD_ROTATE_MS) % WORDS.length];
        const glyph = GLYPHS[glyphIndex % GLYPHS.length];
        const secs = Math.floor((now - workStart) / 1000);
        const toks = estimateTokens(streamedChars);
        l1.append(
          ownedEl("span", {
            owner: OWNER,
            className: "cc-accent-text",
            text: `${glyph ?? "✻"} ${word ?? "Pondering"}…`,
          }),
          ownedEl("span", {
            owner: OWNER,
            className: "cc-faint",
            text: ` (${secs}s · ⚒ ${toks} tokens · esc to interrupt)`,
          }),
        );
      } else {
        // Idle L1: GREEN ● (ready signal) + muted "idle" —
        // the dot color is the distinct idle/working state cue.
        l1.append(
          ownedEl("span", { owner: OWNER, className: "cc-ok-text", text: "●" }),
          ownedEl("span", { owner: OWNER, className: "cc-muted", text: " idle" }),
        );
      }
    };

    const renderContextGauge = (): void => {
      const index = ctx.conversation.current();
      if (!index) {
        r1.textContent = `context ${"▱".repeat(GAUGE_BLOCKS)} —/200k`;
        return;
      }
      const chars = index.messages.reduce((sum, m) => sum + m.text.length, 0);
      const toks = estimateTokens(chars);
      const pct = Math.min(100, (toks / CONTEXT_LIMIT_TOKENS) * 100);
      const filled = Math.min(GAUGE_BLOCKS, Math.round(pct / GAUGE_BLOCKS));
      const totalLabel = toks > 1000 ? `${(toks / 1000).toFixed(1)}k` : `${toks}`;
      const partial = index.source === "dom" ? " (partial)" : "";
      r1.textContent =
        `context ${"▰".repeat(filled)}${"▱".repeat(GAUGE_BLOCKS - filled)} ` +
        `${totalLabel}/200k · ${pct.toFixed(1)}%${partial}`;
    };

    const renderDraftLine = (): void => {
      const draft = ctx.composer.readDraft().trim();
      l2.replaceChildren();
      // Char + word + ~token counts (tokens ≈ chars/4, the rough estimate
      // used everywhere; this line is the everyday readout).
      // The secret guard appends after the counter whenever the setting is
      // on and a secret is detected.
      const counter = draft
        ? `✎ ${draft.length} ch · ${wordCount(draft)} w · ~${Math.max(1, estimateTokens(draft.length))} tok`
        : "✎ no draft";
      l2.append(ownedEl("span", { owner: OWNER, className: "cc-muted", text: counter }));
      const hits = secretGuardOn && draft ? detectSecrets(draft) : [];
      const first = hits[0];
      if (first) {
        // Single hit keeps the original wording; multiple distinct types show
        // a count + the top labels (severity-ordered by detectSecrets).
        const text =
          hits.length === 1
            ? `  ⚠ possible ${first.label} in draft — check before sending`
            : `  ⚠ ${hits.length} possible secrets in draft: ${hits
                .slice(0, 2)
                .map((h) => h.label)
                .join(", ")}${hits.length > 2 ? ` +${hits.length - 2} more` : ""} — check before sending`;
        l2.append(ownedEl("span", { owner: OWNER, className: "cc-danger-text", text }));
      }
    };

    const renderStatsLine = (): void => {
      const index = ctx.conversation.current();
      if (!index) {
        r2.textContent = "";
        return;
      }
      const msgs = index.messages;
      const turns = msgs.filter((m) => m.sender === "human").length;
      let dur = "";
      const first = msgs[0];
      const last = msgs[msgs.length - 1];
      if (msgs.length > 1 && first?.createdAt && last?.createdAt) {
        const d = durationBetween(first.createdAt, last.createdAt);
        if (d) dur = ` · ${d}`;
      }
      r2.textContent = `${msgs.length} msgs · ${turns} turns${dur}`;
    };

    const renderChatId = (): void => {
      if (copiedFlash) return; // "✓ link copied" is showing
      const convId = ctx.storage.convId;
      l3.textContent = convId ? `id ${convId}` : "";
      l3.title = convId ? "Click to copy chat link" : "";
    };

    ctx.listen(l3, "click", () => {
      if (!ctx.storage.convId) return;
      navigator.clipboard
        .writeText(location.href)
        .then(() => {
          copiedFlash = true;
          l3.textContent = "✓ link copied";
          ctx.setTimeout(() => {
            copiedFlash = false;
            renderChatId();
          }, COPIED_FLASH_MS);
        })
        .catch(() => {
          /* clipboard denied — degrade quietly */
        });
    });

    // ---- anchoring: floating pill above the composer (re-tracked per tick) ----
    const setBarVisible = (visible: boolean): void => {
      bar.classList.toggle("cc-hidden", !visible);
      document.documentElement.classList.toggle("cc-has-status", visible);
    };

    const anchor = (): boolean => {
      const box = ctx.composer.container();
      const rect = box?.getBoundingClientRect();
      if (!box || !rect || rect.width <= 0 || rect.height <= 0) {
        setBarVisible(false);
        return false;
      }
      // Unhide before measuring (display:none reports 0 height); the geometry
      // write below lands in the same frame, so nothing paints mispositioned.
      setBarVisible(true);
      const barHeight = bar.offsetHeight || BAR_FALLBACK_HEIGHT_PX;
      setGeometry(bar, {
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        top: Math.round(rect.top - barHeight - BAR_GAP_PX),
      });
      return true;
    };

    // ---- tickers ---------------------------------------------------------------
    ctx.setInterval(() => {
      glyphIndex = (glyphIndex + 1) % GLYPHS.length;
      if (working) renderLine1();
    }, GLYPH_MS);

    const tick = (): void => {
      if (!anchor()) return;
      renderLine1();
      renderContextGauge();
      renderDraftLine();
      renderStatsLine();
      renderChatId();
    };
    ctx.setInterval(tick, TICK_MS);
    tick();

    // ---- teardown ---------------------------------------------------------------
    ctx.onCleanup(() => {
      document.documentElement.classList.remove("cc-has-status");
      bar.remove(); // under #cc-root; the owner sweep is the safety net
    });
  },
};
