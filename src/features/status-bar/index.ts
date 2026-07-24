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
 *  L3 chat id (click to copy the chat link) — repurposed while a Claude Code
 *     send is in flight to narrate the bridge's "bridge:send-lifecycle"
 *     (⇄ sending → ✓ received by <node> · pick up: /mcp__clenby__handoff → ✕
 *     <reason>); the claude-code-bridge feature is the sole producer
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
/** How long a terminal send-lifecycle line (✓ received / ✕ failed) holds
 *  before the chat-id line returns. */
const LIFECYCLE_HOLD_MS = 5000;
/** Safety cap on a "sending…" line that never gets a terminal (e.g. the tab
 *  aborted its push): after this it self-restores to the id line. */
const LIFECYCLE_SENDING_CAP_MS = 30_000;
/** The receive command the bar teaches on a delivered handoff — the bridge's
 *  MCP `handoff` prompt, surfaced by Claude Code as this slash command. */
const HANDOFF_PICKUP_CMD = "/mcp__clenby__handoff";

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

    // ---- send lifecycle (row-3 left segment; claude-code-bridge is the sole
    //      producer) — narrates a Claude Code send in the chat-id slot, then
    //      restores. Only the LATEST send is narrated: a terminal phase from an
    //      older reqId is dropped while a newer send holds the line.
    type LifePhase = "sending" | "received" | "failed";
    let lifePhase: LifePhase | null = null;
    let lifeTarget = "";
    let lifeReason = "";
    /** reqId of the send currently narrated — the key for stale-terminal
     *  rejection. null once no send is being narrated. */
    let lifeReqId: string | null = null;
    /** While Date.now() < this, the lifecycle line owns the segment. */
    let lifeHoldUntil = 0;
    /** Last-painted row-3-left signature — the 500 ms re-render is a no-op while
     *  it is unchanged, so the entrance animation never re-fires mid-hold. */
    let l3Sig = "";
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

    // Row-3 left is normally the chat id (click to copy the link); during a
    // Claude Code send the bridge's lifecycle narration takes it over.
    const l3Signature = (): string => {
      if (lifePhase !== null && Date.now() < lifeHoldUntil) {
        return `life:${lifePhase}:${lifeTarget}:${lifeReason}`;
      }
      if (copiedFlash) return "copied";
      return `id:${ctx.storage.convId ?? ""}`;
    };

    /** Paint row-3-left from the current state. Called by renderL3 ONLY after a
     *  signature change, so the entrance animation fires once per real
     *  transition — not on every tick. */
    const buildL3 = (): void => {
      const life = lifePhase !== null && Date.now() < lifeHoldUntil;
      bar.classList.toggle("cc-life-active", life);
      l3.classList.toggle("cc-life", life);
      l3.replaceChildren();
      if (life) {
        // One animated wrapper (fresh each real change → the ≤200 ms slide-in
        // plays once; companion.css disables it under prefers-reduced-motion).
        const wrap = ownedEl("span", { owner: OWNER, className: "cc-life-in" });
        if (lifePhase === "sending") {
          wrap.append(
            ownedEl("span", {
              owner: OWNER,
              className: "cc-accent-text",
              text: `⇄ sending to ${lifeTarget}…`,
            }),
          );
          l3.title = `Sending to ${lifeTarget}…`;
        } else if (lifePhase === "received") {
          wrap.append(
            ownedEl("span", { owner: OWNER, className: "cc-ok-text", text: "✓" }),
            ` received by ${lifeTarget} · `,
            ownedEl("span", { owner: OWNER, className: "cc-faint", text: "pick up: " }),
            ownedEl("span", { owner: OWNER, className: "cc-life-cmd", text: HANDOFF_PICKUP_CMD }),
          );
          l3.title = `Received by ${lifeTarget}. In Claude Code, run ${HANDOFF_PICKUP_CMD} to pick it up.`;
        } else {
          wrap.append(
            ownedEl("span", { owner: OWNER, className: "cc-danger-text", text: `✕ ${lifeReason}` }),
          );
          l3.title = lifeReason;
        }
        l3.append(wrap);
        return;
      }
      if (copiedFlash) {
        l3.textContent = "✓ link copied";
        l3.title = "";
        return;
      }
      const convId = ctx.storage.convId;
      l3.textContent = convId ? `id ${convId}` : "";
      l3.title = convId ? "Click to copy chat link" : "";
    };

    const renderL3 = (): void => {
      // Retire a finished/stale lifecycle first so the id line can return — this
      // also clears lifeReqId (a later standalone failure is then accepted) and
      // lifts the click-to-copy suspension.
      if (lifePhase !== null && Date.now() >= lifeHoldUntil) {
        lifePhase = null;
        lifeReqId = null;
      }
      const sig = l3Signature();
      if (sig === l3Sig) return; // nothing visible changed — leave the DOM alone
      l3Sig = sig;
      buildL3();
    };

    // The claude-code-bridge feature narrates every send here (it is the sole
    // producer). Latest wins: a new "sending" takes over the segment; a terminal
    // (received/failed) is DROPPED when it echoes an older reqId than the one now
    // narrated. A standalone terminal — e.g. an early "no session" failure with
    // nothing active — is accepted (lifeReqId is null).
    ctx.on("bridge:send-lifecycle", ({ phase, target, reason, reqId }) => {
      const rid = reqId ?? null;
      if (phase === "sending") {
        lifePhase = "sending";
        lifeTarget = target;
        lifeReason = "";
        lifeReqId = rid;
        lifeHoldUntil = Date.now() + LIFECYCLE_SENDING_CAP_MS;
      } else {
        if (lifeReqId !== null && rid !== lifeReqId) return; // stale terminal from an older send
        lifePhase = phase;
        lifeTarget = target;
        lifeReason = reason ?? "";
        lifeReqId = rid;
        lifeHoldUntil = Date.now() + LIFECYCLE_HOLD_MS;
      }
      renderL3();
    });

    ctx.listen(l3, "click", () => {
      // While a send-lifecycle line owns the segment it is NOT the chat-id copy
      // target — swallow the click so a user can't copy the chat link thinking
      // they clicked the id (the title reflects the lifecycle, not "copy").
      if (lifePhase !== null && Date.now() < lifeHoldUntil) return;
      if (!ctx.storage.convId) return;
      navigator.clipboard
        .writeText(location.href)
        .then(() => {
          copiedFlash = true;
          renderL3();
          ctx.setTimeout(() => {
            copiedFlash = false;
            renderL3();
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
      renderL3();
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
