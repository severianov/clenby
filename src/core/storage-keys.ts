/**
 * Every storage key literal in the codebase lives here and nowhere else
 *. When a key changes, it changes in one place.
 */

/** Global settings — stored in `storage.sync`, roams with the profile. */
export const SettingsKey = {
  activePresetId: "cc:activePresetId",
  /** Light/dark for themed presets — a hard two-way "light" | "dark"
   *  choice enforced at compile time (see theme/compile.ts). Legacy stored
   *  "auto" is resolved to claude.ai's current appearance on read. */
  themeMode: "cc:themeMode",
  tweaks: "cc:tweaks",
  panelPos: "cc:panelPos",
  onboarding: "cc:onboarding",
  /** Undo-send delay in seconds (migrated from legacy `cc-undo-delay`). */
  undoDelaySeconds: "cc:undoDelaySeconds",
  /** Enter inserts a newline, Ctrl/Cmd+Enter sends (composer; default
   *  OFF = claude.ai's native Enter-to-send untouched). */
  enterToNewline: "cc:enterToNewline",
  /** Secret detection — scan the draft for keys/passwords and warn in the
   *  status bar before sending (Trust; default ON). */
  secretGuardOn: "cc:secretGuardOn",
  /** "Looks cut off — Continue" affordance on truncated last answers
   *  (Output repair; default ON). */
  truncationGuardOn: "cc:truncationGuardOn",
  /** Display-only re-render of answers a broken code fence swallowed
   *  (Output repair; default ON). */
  fenceFixerOn: "cc:fenceFixerOn",
  /** Snapshot answers before a retry/regenerate so a worse reroll can't lose
   *  the good one (Output repair; default ON). */
  regenSafetyNetOn: "cc:regenSafetyNetOn",
  /** Toolbar on markdown tables in answers — copy TSV, download CSV, expand
   *  (Data & media; default ON). */
  tableToolbarOn: "cc:tableToolbarOn",
  /** Recompute simple arithmetic claims in answers and mark results that
   *  don't add up (Trust++; default OFF — opt-in checking aid). */
  mathCheckerOn: "cc:mathCheckerOn",
  /** Tickable checkboxes on Claude's step lists, remembered per chat
   *  (Delight & memory; default ON). */
  liveChecklistsOn: "cc:liveChecklistsOn",
} as const;

/** Bookkeeping — stored in `storage.local`. */
export const MetaKey = {
  /** Marks the one-time localStorage → storage.local migration as done. */
  migrationDone: "cc:migration:localStorage:v1",
  /** Set by the background page on install/update so the popup can show "what's new". */
  whatsNew: "cc:whatsNew",
  /** draft-keeper bookkeeping: convId → last-saved epoch ms, used to prune the
   *  oldest saved drafts so they never accumulate unbounded. */
  draftIndex: "cc:draftIndex",
  /** live-checklists bookkeeping: convId → last-touched epoch ms, pruned like
   *  draftIndex so checklist state never accumulates unbounded. */
  checklistIndex: "cc:checklistIndex",
  /** The user's own Anthropic API key for the OPT-IN repair tier (self-healing
   *  layer). Written/read ONLY by the background worker (`cc:anthropic:*`
   *  messages); sent only to https://api.anthropic.com, and only after the
   *  optional host permission was granted at runtime. Never synced. */
  anthropicApiKey: "cc:anthropicApiKey",
  /** The per-machine Claude Code bridge pairing token (spec §6). Written/read
   *  ONLY by the background worker; presented to loopback bridges over the WS,
   *  never to the page DOM, never to claude.ai, never to any non-loopback host.
   *  Cleared by "Forget" in the gear pairing panel. Never synced. Literal kept
   *  in sync with `BRIDGE_TOKEN_KEY` in shared/bridge-protocol.ts. */
  bridgeToken: "cc:bridgeToken",
} as const;

/**
 * Self-healing override files — stored in `storage.local` (machine-local:
 * DOM fixes are per-browser-build observations and can exceed sync's quota;
 * roaming happens via explicit export/import). One schema-versioned
 * `OverridesFile` per namespace (`{ v: 1, entries: {} }`), entries keyed by
 * the `SelectorName` / `EndpointName` allowlists — see `core/overrides.ts`.
 */
export const OverrideKey = {
  /** OverridesFile<SelectorOverride> */
  selectors: "cc:overrides:selectors",
  /** OverridesFile<EndpointOverride> */
  endpoints: "cc:overrides:endpoints",
} as const;

/**
 * Per-conversation data kinds — stored in `storage.local`, keyed by
 * {@link convStorageKey}. These can grow large (notes, highlights) so they never
 * go in `storage.sync`.
 */
export type ConvKind =
  | "pins"
  | "notes"
  | "todos"
  | "highlights"
  | "models"
  | "draft"
  | "checklists";

/** `conv:<convId>:<kind>` — the only shape a per-conversation key may take. */
export function convStorageKey(convId: string, kind: ConvKind): string {
  return `conv:${convId}:${kind}`;
}

/**
 * Legacy versions persisted to the page's own `localStorage`. On first run we
 * import these into `storage.local`. Maps a legacy key builder → new ConvKind.
 */
export const LEGACY_LOCALSTORAGE_PREFIXES: ReadonlyArray<{
  prefix: string;
  kind: ConvKind;
}> = [
  { prefix: "cc-notes-", kind: "notes" },
  { prefix: "cc-notes2-", kind: "todos" },
  { prefix: "cc-notes3-", kind: "todos" },
  { prefix: "cc-pins-", kind: "pins" },
  { prefix: "cc-hls-", kind: "highlights" },
];
