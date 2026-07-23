/**
 * Anchor → consumers: which parts of the companion break when an anchor dies.
 * Shown in the dashboard's "Used by" column and in the break-alert banner.
 *
 * This is a HAND-MAINTAINED static map, deliberately — no runtime
 * introspection (scope doc §3). It is kept honest two ways:
 *
 * 1. Compile-time exhaustiveness: `satisfies Record<SelectorName, …>` /
 *    `Record<EndpointName, …>` means adding or renaming an anchor in
 *    `core/selectors.ts` / `api/endpoints.ts` breaks `tsc` HERE until this
 *    map is updated — the table can never silently miss an anchor.
 * 2. Value refresh: entries were derived from the real call sites
 *    (2026-07-22). To re-derive after moving a selector between features:
 *      grep -rln '"<name>"' src --include='*.ts' | grep -v core/selectors
 *    (and `grep -rn "get<Method>" src` for endpoint consumers). Core modules
 *    are listed as `core/<module>`; features by their feature id.
 */

import type { SelectorName } from "@/core/selectors";
import type { EndpointName } from "@/api/endpoints";

export const SELECTOR_DEPS = {
  messageBlock: [
    "core/conversation-store",
    "core/dom-matcher",
    "core/decorations",
    "core/generation",
    "themes",
    "outline",
    "folding",
    "highlights",
    "answer-toolbar",
    "mini-window",
    "regen-safety-net",
    "math-checker",
    "table-extractor",
    "fence-fixer",
    "truncation-guard",
    "live-checklists",
    "image-lightbox",
  ],
  userMessage: ["core/conversation-store", "core/dom-matcher", "themes"],
  assistantMessage: [
    "core/conversation-store",
    "core/dom-matcher",
    "themes",
    "highlights",
    "folding",
    "meta-line",
    "answer-toolbar",
    "regen-safety-net",
    "fence-fixer",
    "math-checker",
    "mini-window",
    "live-checklists",
    "truncation-guard",
  ],
  userBubble: ["themes"],
  codeBlockSurface: ["themes"],
  inlineCode: ["themes"],
  conversationColumn: ["themes"],
  mainContent: ["themes"],
  sidebar: ["themes"],
  composerInput: [
    "core/composer",
    "draft-keeper",
    "undo-send",
    "enter-behavior",
    "truncation-guard",
  ],
  contentEditable: ["core/composer"],
  scrollToBottom: [],
  stopButton: ["core/generation", "done-ping", "status-bar", "truncation-guard"],
  retryButton: ["regen-safety-net"],
  modelPicker: ["meta-line"],
  headerFade: [],
  chatTitle: ["themes"],
  assistantTable: ["table-extractor"],
  messageImage: ["image-lightbox"],
  artifactIframe: ["console-relay"],
} as const satisfies Record<SelectorName, readonly string[]>;

export const ENDPOINT_DEPS = {
  // Every org-scoped call funnels through getPrimaryOrgId → organizations.
  organizations: ["core/api", "core/conversation-store", "usage", "command-palette"],
  account: [],
  conversations: ["command-palette"],
  conversation: [
    "core/conversation-store",
    "outline",
    "export",
    "find-in-conversation",
    "command-palette",
  ],
  usage: ["usage"],
  rateLimits: [],
  projects: [],
} as const satisfies Record<EndpointName, readonly string[]>;

/** Compact "used by" cell text: first few consumers + an ellipsis. */
export function depsSummary(deps: readonly string[], max = 3): string {
  if (deps.length === 0) return "—";
  if (deps.length <= max) return deps.join(", ");
  return `${deps.slice(0, max).join(", ")}, +${deps.length - max} more`;
}
