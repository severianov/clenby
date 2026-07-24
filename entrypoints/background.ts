/**
 * Background worker: toolbar-icon click routing (the popup page was removed
 * 2026-07-22 — in-page settings are THE settings), install/update
 * bookkeeping (what's-new flag), plus the self-healing layer's OPT-IN
 * Anthropic-API repair tier (`cc:anthropic:*` messages). The repair tier
 * lives here because content scripts can neither call
 * `browser.permissions.*` nor fetch api.anthropic.com past claude.ai's CSP —
 * the background requests the OPTIONAL host permission at opt-in time, keeps
 * the user's key in `storage.local`, and performs the single fetch. With the
 * tier disabled (the default), this file performs zero network requests and
 * the install stays claude.ai-only.
 *
 * Icon click (no default_popup → the action fires here): on a claude.ai tab
 * it asks the content script to open the in-page gear settings; elsewhere it
 * focuses an existing claude.ai tab or opens one. Uses only APIs the
 * manifest already covers — tabs.query/update/create and windows.update need
 * no extra permission, and tab URLs are visible for granted hosts.
 *
 * Hardening: every path is guarded so the worker can never surface an uncaught
 * error or unhandled promise rejection on the chrome://extensions card.
 */

import { defineBackground } from "wxt/utils/define-background";
import { browser } from "wxt/browser";
import { MetaKey } from "@/core/storage-keys";
import {
  ANTHROPIC_API_ORIGIN,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
  REPAIR_MAX_PROMPT_CHARS,
  REPAIR_MAX_TOKENS,
  REPAIR_MODEL,
  isAnthropicRepairMessage,
  type AnthropicEnableResult,
  type AnthropicRepairMessage,
  type AnthropicRepairResult,
  type AnthropicStatusResult,
} from "@/shared/anthropic-repair";
import { BridgeManager } from "@/features/claude-code-bridge/manager";
import {
  isBridgeContentMessage,
  isBridgeReadMethod,
  type BridgeAckResult,
  type BridgeComposerReply,
  type BridgeContentMessage,
  type BridgePairResult,
  type BridgeReadReply,
  type BridgeStatus,
} from "@/shared/bridge-protocol";

const REPAIR_FETCH_TIMEOUT_MS = 30_000;

const CLAUDE_ORIGIN = "https://claude.ai/";

/** Toolbar-icon click → the in-page gear settings (on claude.ai) or a
 *  focused/new claude.ai tab (anywhere else). */
async function handleIconClick(tab: { id?: number; url?: string }): Promise<void> {
  // Already on claude.ai: hand off to the content script's gear menu.
  if (tab.id !== undefined && tab.url?.startsWith(CLAUDE_ORIGIN)) {
    try {
      await browser.tabs.sendMessage(tab.id, { type: "cc:open-settings" });
      return;
    } catch {
      // No content script in this tab (still loading / an error page) —
      // fall through to the focus/open path below, which is a no-op-ish
      // "bring claude.ai forward".
    }
  }
  const claudeTabs = await browser.tabs.query({ url: `${CLAUDE_ORIGIN}*` });
  const existing = claudeTabs.find((t) => t.id !== undefined);
  if (existing?.id !== undefined) {
    await browser.tabs.update(existing.id, { active: true });
    // windows API is absent on Firefox for Android — tab activation above
    // already did the job there.
    if (existing.windowId !== undefined && browser.windows?.update) {
      await browser.windows.update(existing.windowId, { focused: true });
    }
  } else {
    await browser.tabs.create({ url: CLAUDE_ORIGIN });
  }
}

async function storedApiKey(): Promise<string | null> {
  const raw = await browser.storage.local.get(MetaKey.anthropicApiKey);
  const key = raw[MetaKey.anthropicApiKey];
  return typeof key === "string" && key.length > 0 ? key : null;
}

function hasAnthropicPermission(): Promise<boolean> {
  return browser.permissions.contains({ origins: [ANTHROPIC_API_ORIGIN] });
}

async function handleStatus(): Promise<AnthropicStatusResult> {
  return {
    ok: true,
    hasKey: (await storedApiKey()) !== null,
    hasPermission: await hasAnthropicPermission(),
  };
}

/** Opt in: permission prompt first (needs the forwarded user gesture — works
 *  on Chrome; Firefox may refuse gestures relayed through messages, in which
 *  case the reason tells the user the session flow still works), then store
 *  the key. The key is never logged and never leaves storage.local except
 *  toward api.anthropic.com. */
async function handleEnable(key: string): Promise<AnthropicEnableResult> {
  const trimmed = key.trim();
  if (!trimmed.startsWith("sk-ant-") || trimmed.length < 20) {
    return { ok: false, reason: "That doesn't look like an Anthropic API key (expected sk-ant-…)." };
  }
  let granted = false;
  try {
    granted = await browser.permissions.request({ origins: [ANTHROPIC_API_ORIGIN] });
  } catch {
    return {
      ok: false,
      reason:
        "The browser refused the permission prompt from here (Firefox requires it from extension UI). The free session flow still works.",
    };
  }
  if (!granted) {
    return { ok: false, reason: "Permission for api.anthropic.com was not granted — nothing was saved." };
  }
  await browser.storage.local.set({ [MetaKey.anthropicApiKey]: trimmed });
  return { ok: true };
}

/** Opt out: forget the key and (best-effort) release the optional permission. */
async function handleDisable(): Promise<AnthropicEnableResult> {
  await browser.storage.local.remove(MetaKey.anthropicApiKey);
  try {
    await browser.permissions.remove({ origins: [ANTHROPIC_API_ORIGIN] });
  } catch {
    // Some browsers refuse programmatic removal — key is gone, which is what matters.
  }
  return { ok: true };
}

/** One Messages-API call with the sanitized repair prompt. The prompt is
 *  structure-only by construction (shared/repair-sketch) — this handler adds
 *  belt-and-suspenders size caps and never logs the key. */
async function handleRepair(prompt: string): Promise<AnthropicRepairResult> {
  if (prompt.length === 0 || prompt.length > REPAIR_MAX_PROMPT_CHARS) {
    return { ok: false, reason: "Repair prompt is empty or oversized — refusing to send." };
  }
  const key = await storedApiKey();
  if (key === null) return { ok: false, reason: "No API key saved — enable the API tier first." };
  if (!(await hasAnthropicPermission())) {
    return { ok: false, reason: "api.anthropic.com permission is missing — re-enable the API tier." };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REPAIR_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_API_VERSION,
        // Required by the API for direct browser-context calls with an
        // API key — the user explicitly opted into exactly this.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: REPAIR_MODEL,
        max_tokens: REPAIR_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const detail =
        typeof json === "object" && json !== null
          ? String(
              (json as { error?: { message?: unknown } }).error?.message ?? "",
            ).slice(0, 200)
          : "";
      return { ok: false, reason: `Claude API error ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    const content =
      typeof json === "object" && json !== null
        ? (json as { content?: unknown }).content
        : null;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          return { ok: true, text: block.text };
        }
      }
    }
    return { ok: false, reason: "Claude returned no usable text — try again." };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { ok: false, reason: aborted ? "Claude API request timed out." : "Network error reaching api.anthropic.com." };
  } finally {
    clearTimeout(timer);
  }
}

function handleRepairMessage(message: AnthropicRepairMessage): Promise<unknown> {
  switch (message.type) {
    case "cc:anthropic:status":
      return handleStatus();
    case "cc:anthropic:enable":
      return handleEnable(message.key);
    case "cc:anthropic:disable":
      return handleDisable();
    case "cc:anthropic:repair":
      return handleRepair(message.prompt);
  }
}

// ===========================================================================
// Claude Code bridge (spec §4–§5). The WS client lives here — a content script
// on https://claude.ai cannot open ws://127.0.0.1 (Reviewer note 2). The
// background scans the loopback range, holds one socket per live bridge, pushes
// handoffs, and relays inbound `push_to_composer` into a claude.ai tab.
// ===========================================================================

/** The most recently focused claude.ai tab — where an inbound composer draft
 *  lands (spec §4 "current" = the last-focused tab). */
let lastFocusedClaudeTab: number | null = null;

async function broadcastToClaudeTabs(message: unknown): Promise<void> {
  let tabs: Array<{ id?: number }> = [];
  try {
    tabs = await browser.tabs.query({ url: `${CLAUDE_ORIGIN}*` });
  } catch {
    return;
  }
  await Promise.all(
    tabs.map(async (t) => {
      if (t.id === undefined) return;
      try {
        await browser.tabs.sendMessage(t.id, message);
      } catch {
        // no content script in that tab (still loading) — skip
      }
    }),
  );
}

/** Resolve the tab an inbound composer draft should target: the last-focused
 *  claude.ai tab, else the active claude.ai tab, else any. */
async function composerTargetTab(): Promise<number | null> {
  if (lastFocusedClaudeTab !== null) {
    try {
      const t = await browser.tabs.get(lastFocusedClaudeTab);
      if (t.url?.startsWith(CLAUDE_ORIGIN)) return lastFocusedClaudeTab;
    } catch {
      lastFocusedClaudeTab = null;
    }
  }
  try {
    const tabs = await browser.tabs.query({ url: `${CLAUDE_ORIGIN}*` });
    const active = tabs.find((t) => t.active && t.id !== undefined);
    const any = tabs.find((t) => t.id !== undefined);
    return (active ?? any)?.id ?? null;
  } catch {
    return null;
  }
}

const bridge = new BridgeManager({
  extVersion: browser.runtime.getManifest().version,
  onRosterChanged: (status: BridgeStatus) => {
    void broadcastToClaudeTabs({ type: "cc:bridge:roster", status });
  },
  reqHandler: async (method, params) => {
    // Reverse-direction READ tools (spec §5): relay to the last-focused
    // claude.ai content script, which answers from the live conversation index /
    // conv-scoped storage. Read-only; no claude.ai tab ⇒ a clean `no_tab` frame.
    if (isBridgeReadMethod(method)) {
      const tabId = await composerTargetTab();
      if (tabId === null) {
        return { ok: false as const, code: "no_tab", message: "No claude.ai tab is open to read from." };
      }
      try {
        const reply = (await browser.tabs.sendMessage(tabId, {
          type: "cc:bridge:read",
          method,
          params,
        })) as BridgeReadReply | undefined;
        if (reply && reply.ok) return { ok: true as const, result: reply.result };
        if (reply && !reply.ok) return { ok: false as const, code: reply.code, message: reply.message };
        return { ok: false as const, code: "no_tab", message: "The claude.ai tab did not answer." };
      } catch {
        return { ok: false as const, code: "no_tab", message: "No claude.ai tab is open to read from." };
      }
    }
    // push_to_composer is the sole write-shaped tool. Anything else degrades.
    if (method !== "push_to_composer") {
      return { ok: false as const, code: "unsupported_method", message: `Unknown method: ${method}` };
    }
    const text =
      typeof params === "object" && params !== null
        ? (params as { text?: unknown }).text
        : undefined;
    if (typeof text !== "string" || text.length === 0) {
      return { ok: false as const, code: "bad_params", message: "push_to_composer needs a text string." };
    }
    const tabId = await composerTargetTab();
    if (tabId === null) {
      return { ok: false as const, code: "no_tab", message: "No claude.ai tab is open to draft into." };
    }
    try {
      const reply = (await browser.tabs.sendMessage(tabId, {
        type: "cc:bridge:push-to-composer",
        text,
      })) as BridgeComposerReply | undefined;
      if (reply && reply.ok) return { ok: true as const, result: { ok: true, drafted: reply.drafted } };
      return { ok: false as const, code: "no_tab", message: "The composer was not reachable." };
    } catch {
      return { ok: false as const, code: "no_tab", message: "No claude.ai tab is open to draft into." };
    }
  },
});

/** Handle one content→background bridge message. Returns undefined for anything
 *  that is not ours so other listeners still see it. */
function handleBridgeMessage(
  message: BridgeContentMessage,
  sender: { tab?: { id?: number; url?: string } },
): Promise<BridgeStatus | BridgePairResult | BridgeAckResult> | undefined {
  switch (message.type) {
    case "cc:bridge:status":
      bridge.wake();
      return Promise.resolve(bridge.status());
    case "cc:bridge:pair":
      return bridge.pair(message.code);
    case "cc:bridge:forget":
      return bridge.forget();
    case "cc:bridge:rescan":
      bridge.wake();
      return Promise.resolve(bridge.status());
    case "cc:bridge:tab-focus": {
      const id = sender.tab?.id;
      if (id !== undefined && sender.tab?.url?.startsWith(CLAUDE_ORIGIN)) {
        lastFocusedClaudeTab = id;
      }
      bridge.wake();
      return undefined;
    }
    case "cc:bridge:push":
      return bridge.push(message.sessionId, message.id, message.markdown, message.meta);
  }
}

export default defineBackground(() => {
  // Last-resort guards. Nothing below should ever reach these, but a stray
  // rejection/error would otherwise be collected as an error badge on the
  // extension card. (`self` is the SW global in Chrome MV3 and the background
  // page window in Firefox MV2 — both support these events.)
  try {
    self.addEventListener("unhandledrejection", (event) => {
      console.warn("[cc:bg] unhandled rejection (contained)", event.reason);
      event.preventDefault();
    });
    self.addEventListener("error", (event) => {
      console.warn("[cc:bg] uncaught error (contained)", event.error ?? event.message);
    });
  } catch {
    // Environment without these events — nothing to guard.
  }

  // Opt-in Anthropic-API repair tier (self-healing layer). Only our own
  // extension contexts can reach runtime.onMessage (no onMessageExternal is
  // registered); the sender check + shape guard are defense in depth.
  browser.runtime.onMessage.addListener(
    (message: unknown, sender: { id?: string }): Promise<unknown> | undefined => {
      try {
        if (sender.id !== browser.runtime.id) return undefined;
        if (!isAnthropicRepairMessage(message)) return undefined;
        return handleRepairMessage(message).catch((err: unknown) => {
          console.warn("[cc:bg] anthropic repair handler failed (contained)", err);
          return { ok: false, reason: "Unexpected background error — see the extension console." };
        });
      } catch (err) {
        console.warn("[cc:bg] onMessage handler failed (contained)", err);
        return undefined;
      }
    },
  );

  // Claude Code bridge: content→background messages (roster/status, pairing,
  // handoff push, composer-draft relay). A separate listener from the Anthropic
  // one — each returns undefined for messages it does not own.
  browser.runtime.onMessage.addListener(
    (message: unknown, sender: { id?: string; tab?: { id?: number; url?: string } }) => {
      try {
        if (sender.id !== browser.runtime.id) return undefined;
        if (!isBridgeContentMessage(message)) return undefined;
        const out = handleBridgeMessage(message, sender);
        if (out === undefined) return undefined;
        return out.catch((err: unknown) => {
          console.warn("[cc:bg] bridge handler failed (contained)", err);
          return bridge.status();
        });
      } catch (err) {
        console.warn("[cc:bg] bridge onMessage failed (contained)", err);
        return undefined;
      }
    },
  );

  // Track the last-focused claude.ai tab for inbound composer drafts (also fed
  // by the content script's focus pings).
  try {
    browser.tabs.onActivated.addListener(({ tabId }) => {
      browser.tabs
        .get(tabId)
        .then((t) => {
          if (t.url?.startsWith(CLAUDE_ORIGIN)) lastFocusedClaudeTab = tabId;
        })
        .catch(() => undefined);
    });
    browser.tabs.onRemoved.addListener((tabId) => {
      if (lastFocusedClaudeTab === tabId) lastFocusedClaudeTab = null;
    });
  } catch (err) {
    console.warn("[cc:bg] tab tracking wiring failed (contained)", err);
  }

  // Load the token/permission and, when paired, start scanning.
  bridge.init().catch((err) => {
    console.warn("[cc:bg] bridge init failed (contained)", err);
  });

  // MV3 eviction fallback (spec §5): with no open socket the worker dies in
  // ~30 s and every setInterval dies with it — the in-worker heartbeat alone
  // cannot rediscover a bridge that starts later. An alarm survives eviction:
  // it revives the worker, wake() rescans, and once a socket is welcomed the
  // WS traffic keeps the worker warm again. 30 s is the alarms API minimum.
  try {
    browser.alarms.create("cc:bridge-rescan", { periodInMinutes: 0.5 });
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === "cc:bridge-rescan") bridge.wake();
    });
  } catch (err) {
    console.warn("[cc:bg] bridge alarm wiring failed (contained)", err);
  }

  // Toolbar-icon click (no default_popup, so the action event fires).
  // Chrome MV3 exposes `action`, Firefox MV2 `browserAction` — same event.
  try {
    const action = browser.action ?? browser.browserAction;
    action?.onClicked.addListener((tab) => {
      handleIconClick(tab ?? {}).catch((err) => {
        console.warn("[cc:bg] icon click handling failed (contained)", err);
      });
    });
  } catch (err) {
    console.warn("[cc:bg] icon click wiring failed (contained)", err);
  }

  browser.runtime.onInstalled.addListener((details) => {
    try {
      if (details.reason !== "install" && details.reason !== "update") return;
      browser.storage.local
        .set({
          [MetaKey.whatsNew]: {
            reason: details.reason,
            version: browser.runtime.getManifest().version,
            at: Date.now(),
          },
        })
        .catch((err) => {
          console.warn("[cc:bg] failed to record what's-new flag", err);
        });
    } catch (err) {
      console.warn("[cc:bg] onInstalled handler failed (contained)", err);
    }
  });
});
