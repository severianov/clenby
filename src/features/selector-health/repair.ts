/**
 * "Repair with Claude" — Phase 3 of the self-healing layer. One broken (or
 * fallback-limping) SELECTOR anchor → Claude proposes a replacement from a
 * sanitized structure-only DOM sketch → the proposal is validated + live-
 * probed + flashed on the page → shown as a red→green diff → applied only on
 * the user's click through `ctx.overrides.set(…, source: "repair")`. NEVER
 * auto-applied. Endpoint anchors stay on the manual editor (path templates
 * are typed, not sketched).
 *
 * Two engines, user's choice:
 * - SESSION (default, free, zero new permissions): the ready-made prompt is
 *   copied to the CLIPBOARD and a claude.ai chat tab is opened; the user
 *   sends it, copies Claude's one-line answer, and pastes it into OUR OWN
 *   textarea below. No step touches the possibly-broken composer/message
 *   anchors — clipboard out, own-UI paste-back in, direct
 *   `document.querySelectorAll` probe. The repair path works even when the
 *   composer selectors are the ones that broke.
 * - API KEY (opt-in): the background worker requests the OPTIONAL
 *   api.anthropic.com host permission at enable time, stores the user's key
 *   in storage.local, and makes one small Haiku-class call per repair
 *   (~pennies). Both engines feed the SAME validate → probe → diff → apply
 *   pipeline — model output is untrusted input, always.
 *
 * Standards: own-UI-only (mounted into the health panel's repair host), all
 * DOM built once via ownedEl with listeners on stable elements through
 * ctx.listen, var(--cc-*) tokens only, decorations flash cleared on unmount.
 */

import type { FeatureContext } from "@/core/feature";
import { SELECTORS, type SelectorEntry, type SelectorName } from "@/core/selectors";
import { isValidCssSelector } from "@/core/overrides";
import { ownedEl } from "@/ui/root";
import { relativeTime } from "@/shared/time";
import {
  buildDomSketch,
  buildRepairPrompt,
  parseSelectorReply,
  resolvePathPrefix,
} from "@/shared/repair-sketch";
import {
  CLAUDE_NEW_CHAT_URL,
  type AnthropicEnableResult,
  type AnthropicRepairMessage,
  type AnthropicRepairResult,
  type AnthropicStatusResult,
} from "@/shared/anthropic-repair";
import { browser } from "wxt/browser";
import { SELECTOR_DEPS, depsSummary } from "./deps";

/** Anchors that should match exactly ONE element — a multi-match proposal
 *  for these gets a "too broad" warning in the plausibility line. */
const EXPECT_UNIQUE: ReadonlySet<SelectorName> = new Set([
  "mainContent",
  "sidebar",
  "conversationColumn",
  "composerInput",
  "modelPicker",
  "scrollToBottom",
  "stopButton",
  "headerFade",
] satisfies SelectorName[]);

/** Above this many matches, any anchor is suspicious. */
const SUSPICIOUS_MATCHES = 200;

type RepairSource = "session" | "api";

const SOURCE_HINTS: Record<RepairSource, string> = {
  session:
    "Copies a ready-made repair prompt (structure-only sketch, no conversation text) and opens a claude.ai chat — you send it there, then paste Claude's one-line answer back below. Free, no new permissions, nothing leaves the browser beyond your own conversation.",
  api:
    "One call to api.anthropic.com with an API key stored only in this browser's local storage and sent only to Anthropic. Costs pennies per repair. Opt-in: this is the single exception to “nothing leaves the browser”.",
};

function sendBg<T>(message: AnthropicRepairMessage): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}

export interface RepairControllerOptions {
  ctx: FeatureContext;
  owner: string;
  /** The panel's repair host (panel.ts) — the card mounts here. */
  host: HTMLElement;
  /** Called after a successful Apply so the dashboard/editor re-render. */
  onApplied: () => void;
}

export interface RepairController {
  /** Open (or retarget) the repair card for one selector anchor. */
  open(name: SelectorName): void;
  close(): void;
  readonly isOpen: boolean;
  /** The card element — for scrollIntoView from the panel. */
  readonly element: HTMLElement;
}

export function createRepairController(opts: RepairControllerOptions): RepairController {
  const { ctx, owner, host, onApplied } = opts;

  // ---- state ---------------------------------------------------------------
  let name: SelectorName | null = null;
  let source: RepairSource = "session";
  let prompt = "";
  let brokenSelector = "";
  let proposal: string | null = null;
  let matchedEls: Element[] = [];
  let apiEnabled = false;

  // ---- DOM (built once; renders only toggle text/visibility) ---------------
  const E = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
    attrs?: Record<string, string>,
  ): HTMLElementTagNameMap[K] =>
    ownedEl(tag, {
      owner,
      ...(className !== undefined ? { className } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(attrs !== undefined ? { attrs } : {}),
    });

  const card = E("div", "cc-sh-card cc-sr-card cc-hidden");
  card.dataset["ccRepair"] = "card";

  // head
  const head = E("div", "cc-sr-head");
  const nameEl = E("span", "cc-sr-name");
  const headMeta = E("span", "cc-sh-meta cc-sr-head-meta");
  const closeBtn = E("button", "cc-sh-x", "✕", {
    type: "button",
    title: "Close repair",
    "aria-label": "Close repair",
  });
  head.append(E("span", "cc-sr-head-t", "Repair with Claude"), nameEl, headMeta, closeBtn);

  // body
  const body = E("div", "cc-sr-body");

  const fld = (label: string, ...content: HTMLElement[]): HTMLDivElement => {
    const wrap = E("div", "cc-sr-fld");
    wrap.append(E("div", "cc-sr-k", label), ...content);
    return wrap;
  };

  const brokenEl = E("div", "cc-sr-code cc-sr-code-bad");
  const usedEl = E("div", "cc-sr-used");

  // source toggle
  const srcSessionBtn = E("button", "cc-sr-src", undefined, { type: "button" });
  srcSessionBtn.append(
    E("span", "cc-sr-src-t", "This claude.ai session"),
    E("span", "cc-sr-src-d", "free · guided chat, paste answer back"),
  );
  const srcApiBtn = E("button", "cc-sr-src", undefined, { type: "button" });
  srcApiBtn.append(
    E("span", "cc-sr-src-t", "My API key"),
    E("span", "cc-sr-src-d", "one click · ~pennies per repair"),
  );
  const srcRow = E("div", "cc-sr-srcrow");
  srcRow.append(srcSessionBtn, srcApiBtn);
  const hintEl = E("div", "cc-sr-hint");

  // session engine
  const sessionBlock = E("div", "cc-sr-engine");
  const copyBtn = E("button", "cc-sh-btn-accent", "Copy repair prompt + open a Claude chat", {
    type: "button",
    title: "Copies the sanitized prompt to your clipboard and opens claude.ai/new in a new tab",
  });
  const viewPromptBtn = E("button", "cc-sh-mini", "view prompt", {
    type: "button",
    title: "Show exactly what will be sent — structure only, never conversation text",
  });
  const copyRow = E("div", "cc-sr-row");
  copyRow.append(copyBtn, viewPromptBtn);
  const copyNote = E("div", "cc-sr-note cc-hidden");
  const promptTa = E("textarea", "cc-input cc-sr-ta cc-sr-mono cc-hidden", undefined, {
    rows: "8",
    readonly: "true",
    spellcheck: "false",
    "aria-label": "The repair prompt that will be sent to Claude",
  });
  const pasteTa = E("textarea", "cc-input cc-sr-ta cc-sr-mono", undefined, {
    rows: "2",
    spellcheck: "false",
    placeholder: 'Paste Claude’s one-line answer here, e.g. button[aria-label="Retry response"]',
    "aria-label": "Paste Claude's proposed selector",
  });
  const validateBtn = E("button", "cc-btn", "Validate on this page", { type: "button" });
  sessionBlock.append(
    copyRow,
    copyNote,
    promptTa,
    fld("Paste Claude's answer", pasteTa, validateBtn),
  );

  // api engine — opt-in box (disabled state)
  const apiBlock = E("div", "cc-sr-engine cc-hidden");
  const optinBox = E("div", "cc-sr-optin");
  optinBox.append(
    E(
      "div",
      "cc-sr-note",
      "Enable one-click repairs with your own Anthropic API key. The key is stored only in this browser's extension storage and sent only to api.anthropic.com — after you grant that single optional permission. Each repair is one small model call (~pennies). Everything else in Clenby keeps working without this.",
    ),
  );
  const keyInput = E("input", "cc-input cc-sr-mono", undefined, {
    type: "password",
    placeholder: "sk-ant-…",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Anthropic API key",
  });
  const enableBtn = E("button", "cc-sh-btn-accent", "Grant permission + save key", { type: "button" });
  const optinRow = E("div", "cc-sr-row");
  optinRow.append(keyInput, enableBtn);
  optinBox.append(optinRow);

  // api engine — ready state
  const readyBox = E("div", "cc-sr-ready cc-hidden");
  const askBtn = E("button", "cc-sh-btn-accent", "Ask Claude to fix it", { type: "button" });
  const forgetBtn = E("button", "cc-sh-mini", "forget key + revoke permission", { type: "button" });
  const readyRow = E("div", "cc-sr-row");
  readyRow.append(askBtn, forgetBtn);
  const thinking = E("div", "cc-sr-thinking cc-hidden");
  thinking.append(
    E("span", "cc-sr-spin", undefined, { "aria-hidden": "true" }),
    E("span", undefined, "Sending sanitized DOM sketch (tags + attributes only, no text)…"),
  );
  readyBox.append(readyRow, thinking);
  apiBlock.append(optinBox, readyBox);

  // shared error line
  const errEl = E("div", "cc-sh-err cc-hidden", undefined, { role: "status" });

  // proposal (diff + probe verdict + actions)
  const proposalEl = E("div", "cc-sr-proposal cc-hidden");
  const diffDel = E("div", "cc-sr-ln cc-sr-del");
  const diffDelText = E("span", "cc-sr-ln-text");
  diffDel.append(E("span", "cc-sr-sgn", "−", { "aria-hidden": "true" }), diffDelText);
  const diffAdd = E("div", "cc-sr-ln cc-sr-add");
  const diffAddText = E("span", "cc-sr-ln-text");
  diffAdd.append(E("span", "cc-sr-sgn", "+", { "aria-hidden": "true" }), diffAddText);
  const diff = E("div", "cc-sr-diff");
  diff.append(diffDel, diffAdd);
  const validEl = E("div", "cc-sr-valid", undefined, { role: "status" });
  const warnEl = E("div", "cc-sr-warn cc-hidden");
  const applyBtn = E("button", "cc-sh-btn-accent", "Apply override", { type: "button" });
  const rejectBtn = E("button", "cc-btn", "Reject", { type: "button" });
  const flashBtn = E("button", "cc-sh-mini", "highlight matches", {
    type: "button",
    title: "Flash-outline the elements this selector grabs",
  });
  const actRow = E("div", "cc-sr-row");
  actRow.append(
    applyBtn,
    rejectBtn,
    flashBtn,
    E("span", "cc-sh-meta", "applies instantly · no reload"),
  );
  proposalEl.append(fld("Claude proposes", diff), validEl, warnEl, actRow);

  // done state
  const doneEl = E("div", "cc-sr-done cc-hidden");
  const doneText = E("span");
  doneEl.append(E("span", undefined, "✓", { "aria-hidden": "true" }), doneText);

  body.append(
    fld("Broken selector", brokenEl),
    fld("What it used to match", usedEl),
    fld("Ask Claude via", srcRow, hintEl),
    sessionBlock,
    apiBlock,
    errEl,
    proposalEl,
    doneEl,
  );
  card.append(head, body);
  host.append(card);
  ctx.onCleanup(() => {
    ctx.decorations.clearFlash();
    card.remove();
  });

  // ---- helpers -------------------------------------------------------------
  const show = (el: HTMLElement, on: boolean): void => {
    el.classList.toggle("cc-hidden", !on);
  };

  const setError = (text: string | null): void => {
    errEl.textContent = text ?? "";
    show(errEl, text !== null);
  };

  const clearProposal = (): void => {
    proposal = null;
    matchedEls = [];
    ctx.decorations.clearFlash();
    show(proposalEl, false);
  };

  const renderSource = (): void => {
    srcSessionBtn.classList.toggle("cc-sr-src-sel", source === "session");
    srcApiBtn.classList.toggle("cc-sr-src-sel", source === "api");
    hintEl.textContent = SOURCE_HINTS[source];
    show(sessionBlock, source === "session");
    show(apiBlock, source === "api");
  };

  const renderApiState = (): void => {
    show(optinBox, !apiEnabled);
    show(readyBox, apiEnabled);
  };

  const refreshApiStatus = (): void => {
    void sendBg<AnthropicStatusResult>({ type: "cc:anthropic:status" })
      .then((res) => {
        if (ctx.signal.aborted) return;
        apiEnabled = res.ok && res.hasKey && res.hasPermission;
        renderApiState();
      })
      .catch(() => {
        if (ctx.signal.aborted) return;
        apiEnabled = false;
        renderApiState();
      });
  };

  /** Region to sketch: nearest surviving ancestor from the last-match
   *  evidence path, else mainContent, else body — never the broken anchor
   *  itself, and never dependent on it. */
  const sketchRoot = (anchor: SelectorName): Element => {
    const path = ctx.selectors.health().get(anchor)?.lastMatchPath ?? null;
    if (path) {
      const hit = resolvePathPrefix<Element>(path, (sel) => {
        try {
          return document.querySelector(sel);
        } catch {
          return null;
        }
      });
      if (hit) return hit;
    }
    return ctx.selectors.query("mainContent") ?? document.body;
  };

  const probe = (selector: string): Element[] | null => {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return null;
    }
  };

  const showProposal = (parsed: string, els: Element[]): void => {
    proposal = parsed;
    matchedEls = els;
    setError(null);
    diffDelText.textContent = brokenSelector;
    diffAddText.textContent = parsed;
    const n = els.length;
    validEl.textContent = `✓ now matches ${n} element${n === 1 ? "" : "s"}`;
    let warn: string | null = null;
    if (name !== null && EXPECT_UNIQUE.has(name) && n > 1) {
      warn = `⚠ ${name} should match exactly ONE element — this selector may be too broad. Apply only if the highlight looks right.`;
    } else if (n > SUSPICIOUS_MATCHES) {
      warn = `⚠ ${n} matches is suspiciously broad for this anchor. Apply only if the highlight looks right.`;
    }
    warnEl.textContent = warn ?? "";
    show(warnEl, warn !== null);
    show(proposalEl, true);
    ctx.decorations.flash(els);
  };

  /** The shared pipeline both engines feed: parse → syntax-validate → live
   *  probe → flash + diff. Model output is untrusted input, always. */
  const validateReply = (raw: string): void => {
    clearProposal();
    const parsed = parseSelectorReply(raw);
    if (parsed === null) {
      setError("Couldn't find a selector in that reply — paste Claude's one-line answer (just the selector).");
      return;
    }
    const shown = parsed.slice(0, 120); // capture before the guard narrows to never
    if (!isValidCssSelector(parsed)) {
      setError(`Not a valid CSS selector (or longer than 1 KB): ${shown}`);
      return;
    }
    const els = probe(parsed);
    if (els === null) {
      setError("The browser rejected that selector — it may use unsupported syntax.");
      return;
    }
    if (els.length === 0) {
      setError(
        "The selector parses but matches NOTHING on this page — still broken. Ask Claude again (the page may need the element visible), or fix it by hand in the editor below.",
      );
      return;
    }
    showProposal(parsed, els);
  };

  // ---- listeners (stable elements, registered once) ------------------------
  ctx.listen(closeBtn, "click", () => close());

  ctx.listen(srcSessionBtn, "click", () => {
    source = "session";
    renderSource();
  });
  ctx.listen(srcApiBtn, "click", () => {
    source = "api";
    renderSource();
    refreshApiStatus();
  });

  ctx.listen(copyBtn, "click", () => {
    // Clipboard delivery — deliberately NOT composer insertText: the repair
    // flow must work when the composer anchor itself is what broke.
    void navigator.clipboard
      .writeText(prompt)
      .then(() => {
        if (ctx.signal.aborted) return;
        copyNote.textContent =
          "✓ Prompt copied. Paste + send it in the Claude tab that just opened, then copy the one-line answer and paste it below.";
        show(copyNote, true);
      })
      .catch(() => {
        if (ctx.signal.aborted) return;
        copyNote.textContent =
          "Clipboard was blocked — the prompt is shown below; copy it yourself, send it in the new tab, then paste the answer back here.";
        show(copyNote, true);
        promptTa.value = prompt;
        show(promptTa, true);
      })
      .finally(() => {
        if (ctx.signal.aborted) return;
        window.open(CLAUDE_NEW_CHAT_URL, "_blank", "noopener");
      });
  });

  ctx.listen(viewPromptBtn, "click", () => {
    const showing = promptTa.classList.contains("cc-hidden");
    promptTa.value = prompt;
    show(promptTa, showing);
    viewPromptBtn.textContent = showing ? "hide prompt" : "view prompt";
  });

  ctx.listen(validateBtn, "click", () => validateReply(pasteTa.value));
  ctx.listen(pasteTa, "paste", () => {
    // Let the paste land, then validate automatically — one less click.
    ctx.setTimeout(() => {
      if (pasteTa.value.trim().length > 0) validateReply(pasteTa.value);
    }, 0);
  });

  ctx.listen(enableBtn, "click", () => {
    const key = keyInput.value.trim();
    if (key.length === 0) {
      setError("Paste your Anthropic API key first (sk-ant-…).");
      return;
    }
    setError(null);
    enableBtn.disabled = true;
    void sendBg<AnthropicEnableResult>({ type: "cc:anthropic:enable", key })
      .then((res) => {
        if (ctx.signal.aborted) return;
        enableBtn.disabled = false;
        if (!res.ok) {
          setError(res.reason);
          return;
        }
        keyInput.value = "";
        apiEnabled = true;
        renderApiState();
      })
      .catch(() => {
        if (ctx.signal.aborted) return;
        enableBtn.disabled = false;
        setError("Could not reach the background worker — reload the tab and try again.");
      });
  });

  ctx.listen(forgetBtn, "click", () => {
    void sendBg<AnthropicEnableResult>({ type: "cc:anthropic:disable" })
      .then(() => {
        if (ctx.signal.aborted) return;
        apiEnabled = false;
        renderApiState();
      })
      .catch(() => undefined);
  });

  ctx.listen(askBtn, "click", () => {
    setError(null);
    clearProposal();
    askBtn.disabled = true;
    show(thinking, true);
    void sendBg<AnthropicRepairResult>({ type: "cc:anthropic:repair", prompt })
      .then((res) => {
        if (ctx.signal.aborted) return;
        askBtn.disabled = false;
        show(thinking, false);
        if (!res.ok) {
          setError(res.reason);
          if (/permission|key/i.test(res.reason)) refreshApiStatus();
          return;
        }
        validateReply(res.text);
      })
      .catch(() => {
        if (ctx.signal.aborted) return;
        askBtn.disabled = false;
        show(thinking, false);
        setError("Could not reach the background worker — reload the tab and try again.");
      });
  });

  ctx.listen(flashBtn, "click", () => {
    if (matchedEls.length > 0) ctx.decorations.flash(matchedEls);
  });

  ctx.listen(rejectBtn, "click", () => {
    clearProposal();
    setError(null);
    pasteTa.value = "";
  });

  ctx.listen(applyBtn, "click", () => {
    if (name === null || proposal === null) return;
    const anchor = name;
    const applied = proposal;
    applyBtn.disabled = true;
    void ctx.overrides
      .set("selectors", anchor, {
        primary: applied,
        source: "repair",
        note: `Claude-assisted repair (${source === "api" ? "API" : "session"} flow)`,
      })
      .then((res) => {
        if (ctx.signal.aborted) return;
        applyBtn.disabled = false;
        if (!res.ok) {
          setError(`Override rejected by validation: ${res.reason}`);
          return;
        }
        clearProposal();
        show(sessionBlock, false);
        show(apiBlock, false);
        doneText.textContent = "";
        doneText.append(
          ownedEl("b", { owner, text: `${anchor} healed. ` }),
          ownedEl("span", {
            owner,
            className: "cc-sr-mono cc-sh-meta",
            text: "Saved to your local overrides — survives updates.",
          }),
        );
        show(doneEl, true);
        onApplied();
      })
      .catch(() => {
        if (ctx.signal.aborted) return;
        applyBtn.disabled = false;
        setError("Saving the override failed — see the console.");
      });
  });

  // ---- open / close --------------------------------------------------------
  let openFlag = false;

  const close = (): void => {
    if (!openFlag) return;
    openFlag = false;
    name = null;
    clearProposal();
    setError(null);
    show(card, false);
  };

  const open = (anchor: SelectorName): void => {
    openFlag = true;
    name = anchor;
    source = "session";
    clearProposal();
    setError(null);
    pasteTa.value = "";
    copyNote.textContent = "";
    show(copyNote, false);
    show(promptTa, false);
    viewPromptBtn.textContent = "view prompt";
    show(doneEl, false);
    show(sessionBlock, true);
    show(thinking, false);

    const entry: SelectorEntry = SELECTORS[anchor];
    const override = ctx.overrides.list().selectors.get(anchor);
    const health = ctx.selectors.health().get(anchor);
    brokenSelector = override?.primary ?? entry.primary;

    nameEl.textContent = anchor;
    const deps = SELECTOR_DEPS[anchor];
    headMeta.textContent = deps.length > 0 ? `${depsSummary(deps)} degraded` : "";
    brokenEl.textContent = brokenSelector;

    const bits: string[] = [`“${entry.description}”`];
    if (health && health.lastMatchedAt !== null) {
      bits.push(
        `last matched ${relativeTime(new Date(health.lastMatchedAt).toISOString())} · ${health.matchCount}× this session`,
      );
    } else {
      bits.push("never matched this session");
    }
    const fallbacks = entry.fallbacks ?? [];
    if (health?.state === "fallback") {
      bits.push("the shipped primary is dead — a fallback is holding the line");
    } else if (fallbacks.length > 0) {
      bits.push(`${fallbacks.length} shipped fallback${fallbacks.length === 1 ? "" : "s"} also miss`);
    }
    usedEl.textContent = bits.join(" — ") + ".";

    // Evidence bundle: sketch from the remembered region, prompt from the
    // sanitized builders. Computed at open so it reflects the current page.
    const sketch = buildDomSketch(sketchRoot(anchor));
    prompt = buildRepairPrompt({
      name: anchor,
      description: entry.description,
      broken: brokenSelector,
      fallbacks,
      lastMatched:
        health && health.lastMatchedAt !== null
          ? `${relativeTime(new Date(health.lastMatchedAt).toISOString())} (${health.matchCount}× this session)`
          : null,
      sketch,
    });

    renderSource();
    renderApiState();
    refreshApiStatus();
    show(card, true);
  };

  return {
    open,
    close,
    get isOpen() {
      return openFlag;
    },
    element: card,
  };
}
