/**
 * The self-healing override layer.
 *
 * A storage-backed, data-only override store that sits UNDER `Selectors` and
 * the API client: when claude.ai ships a breaking DOM/endpoint change, a
 * validated override re-aims an existing anchor without a code update.
 * Features keep calling `ctx.selectors.query(name)` / `api.*` exactly as
 * before — resolution changes, call sites do not.
 *
 * Invariants:
 * - Overrides are data, only data: strings validated against the existing
 *   `SelectorName` / `EndpointName` allowlists. No new anchors can be
 *   introduced, no vocabulary exists that could express code.
 * - Endpoint overrides are structurally origin-pinned: relative `/api/…`
 *   path templates only — no scheme, no host, no `//`, no `..`. Validated at
 *   write time AND re-validated at read time (defense in depth against a
 *   hand-edited storage blob).
 * - Shipped defaults are immortal: they stay in the candidate chain under any
 *   override, and per-entry reset restores them exactly.
 * - This layer performs zero network requests.
 *
 * With no overrides stored (every current user), the layer is a strict no-op:
 * resolution order, fallbacks, and logging are byte-identical to before.
 */

import { browser } from "wxt/browser";
import type { EventBus } from "./event-bus";
import type { CompanionStorage } from "./storage";
import { OverrideKey } from "./storage-keys";
import { SELECTORS, type SelectorEntry, type SelectorName } from "./selectors";
import { ENDPOINT_PARAMS, Endpoints, type EndpointName } from "@/api/endpoints";

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

export type OverrideSource = "user" | "repair" | "community";

export interface SelectorOverride {
  primary: string;
  fallbacks?: string[];
  /** Core version the override was written against (from the manifest).
   *  Drives the "core now ships its own fix" review prompt. */
  basedOn: string;
  /** Provenance — shown in the editor and the health dashboard. */
  source: OverrideSource;
  /** ISO timestamp of the write. */
  at: string;
  /** Optional human note ("claude.ai build f3a2 renamed data-testid"). */
  note?: string;
  /** Hash of the SHIPPED default entry at write time. When it no longer
   *  matches the current shipped entry, core ships its own fix and the
   *  override is stale — surfaced via {@link OverrideStore.isStale}. */
  defaultHash?: string;
}

export interface EndpointOverride {
  /** Same-origin PATH TEMPLATE with named placeholders, e.g.
   *  "/api/organizations/{orgId}/chat_conversations/{convId}?tree=True".
   *  Placeholders are the endpoint's existing parameter names
   *  ({@link ENDPOINT_PARAMS}). */
  pathTemplate: string;
  basedOn: string;
  source: OverrideSource;
  at: string;
  note?: string;
  defaultHash?: string;
}

/** One schema-versioned file per namespace, stored in `storage.local`. */
export interface OverridesFile<T> {
  /** Schema version of THIS file. Bumped only when the record shape changes;
   *  forward migrations follow the `migrateLegacyLocalStorage` precedent. */
  v: 1;
  entries: Partial<Record<string, T>>; // keyed by SelectorName / EndpointName
}

/** What callers pass to {@link OverrideStore.set} — the store fills in
 *  `at`, `basedOn`, and `defaultHash` itself. */
export interface SelectorOverrideInput {
  primary: string;
  fallbacks?: string[];
  source: OverrideSource;
  note?: string;
}

export interface EndpointOverrideInput {
  pathTemplate: string;
  source: OverrideSource;
  note?: string;
}

export type SetResult = { ok: true } | { ok: false; reason: string };

/** Portable export envelope — what {@link OverrideStore.exportFile} produces
 *  and {@link OverrideStore.importFile} accepts. Roaming happens via this
 *  explicit export/import (the files themselves are machine-local). */
export interface OverridesExport {
  kind: "clenby-overrides";
  exportedAt: string;
  coreVersion: string;
  selectors: OverridesFile<SelectorOverride>;
  endpoints: OverridesFile<EndpointOverride>;
}

export type ImportResult =
  | { ok: true; selectors: number; endpoints: number; dropped: number }
  | { ok: false; reason: string };

/**
 * The read/write slice features receive as `ctx.overrides` — the surface the
 * selector-health dashboard + override editor build on. Every mutation goes
 * through the store's validated write path (§1.2 of the scope doc); this
 * interface exposes no way around it.
 */
export interface FeatureOverrides {
  list(): {
    selectors: ReadonlyMap<SelectorName, SelectorOverride>;
    endpoints: ReadonlyMap<EndpointName, EndpointOverride>;
  };
  set(ns: "selectors", name: SelectorName, input: SelectorOverrideInput): Promise<SetResult>;
  set(ns: "endpoints", name: EndpointName, input: EndpointOverrideInput): Promise<SetResult>;
  reset(ns: "selectors", name: SelectorName): Promise<void>;
  reset(ns: "endpoints", name: EndpointName): Promise<void>;
  isStale(ns: "selectors", name: SelectorName): boolean;
  isStale(ns: "endpoints", name: EndpointName): boolean;
  selectorHealth(): ReadonlyMap<SelectorName, SelectorHealth>;
  endpointHealth(): ReadonlyMap<EndpointName, SelectorHealth>;
  exportFile(): OverridesExport;
  importFile(raw: unknown): Promise<ImportResult>;
  /** Fires after any override change lands (own write or another context's —
   *  both arrive via `storage.onChanged`). Returns an unsubscribe function;
   *  features register it with `ctx.onCleanup`. */
  onChanged(cb: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Health ledger shapes
// ---------------------------------------------------------------------------

export type AnchorState = "healthy" | "override" | "fallback" | "broken" | "unknown";

export interface SelectorHealth {
  state: AnchorState;
  lastMatchedVariant: string | null;
  /** Epoch ms. */
  lastMatchedAt: number | null;
  /** This session. */
  matchCount: number;
  /** Consecutive zero-result queries (or failed requests) since last match. */
  missStreak: number;
  /**
   * Last-match evidence for the repair flow: the matched element's structural
   * ancestor path (`shared/repair-sketch.buildAncestorPath` — stable hooks
   * only, same privacy policy as the DOM sketch). Remembered while the anchor
   * still matches so a now-BROKEN anchor still points at a region to sketch;
   * session-scoped like the rest of the ledger. Null until first capture
   * (endpoints never set it).
   */
  lastMatchPath: string | null;
}

/**
 * Anchors that exist on every settled claude.ai CONVERSATION page — the ONLY
 * selectors a miss streak may mark `broken` from absence (plus the
 * trigger-gated ones below, while their trigger is active), and only while a
 * conversation route is actually open: on /new, /settings, /projects there
 * are legitimately no message blocks (and sometimes no composer), and the
 * core pollers keep querying — absence there must not raise the break
 * alert. Every other anchor is CONTENT-DEPENDENT (`assistantTable` exists only in chats with rendered tables,
 * `messageImage` only around images, `retryButton` only near answers, …):
 * for those, absence is NEVER evidence of breakage — claude.ai's
 * virtualization unrenders off-screen messages constantly, so "matched
 * earlier, missing now" is the NORMAL state seconds after scrolling away
 * from a table (that old inference produced a false break-alert every time
 * a table left the viewport). A genuinely dead content selector surfaces as
 * its feature quietly idle + a stale "last matched" in the dashboard, and
 * repair remains available there — it just never cries wolf.
 */
export const ALWAYS_PRESENT: readonly SelectorName[] = [
  "messageBlock",
  "composerInput",
  "mainContent",
  "sidebar",
  "conversationColumn",
];

/**
 * Trigger-gated TRANSIENT anchors — they exist only while a runtime trigger
 * is active. `stopButton` (also the generation detector's own primary anchor)
 * exists only while Claude is generating; at idle its absence is the normal
 * state, never evidence of breakage. Misses accrue toward `broken` ONLY while
 * generation is running (the detector's `generation:start`/`generation:end`
 * bus events open/close the gate), and each active period starts with a
 * fresh streak. This replaces the old "matched earlier this session" rule for
 * these anchors, which false-flagged `broken` after every generation: the
 * detector (and status-bar / done-ping / truncation-guard) kept polling the
 * stop button after it legitimately left the DOM, the miss streak crossed the
 * threshold, and — because the anchor HAD matched during the generation —
 * the ledger declared it broken.
 */
export const GENERATION_GATED: readonly SelectorName[] = ["stopButton"];

/**
 * A gated anchor that matched this recently has "legitimately just left":
 * between the stop button leaving the DOM and `generation:end` landing on the
 * next detector tick (≤500 ms) several features may each poll and miss, so
 * the streak can cross the threshold while the gate is still open. Any miss
 * within this window after a match therefore never flips `broken`.
 */
const TRANSIENT_GRACE_MS = 2000;

/** Misses before a streak may flip an anchor to `broken`. */
const BROKEN_MISS_STREAK = 3;
/** The page must have been up this long before absence means anything. */
const SETTLE_MS = 5000;

// ---------------------------------------------------------------------------
// Validation — the only door into the store
// ---------------------------------------------------------------------------

const SELECTOR_MAX_LEN = 1024; // 1 KB per selector string
const TEMPLATE_MAX_LEN = 2048;
const NOTE_MAX_LEN = 500;
const MAX_FALLBACKS = 8;

const SELECTOR_NAMES = Object.keys(SELECTORS) as readonly SelectorName[];
const ENDPOINT_NAMES = Object.keys(Endpoints) as readonly EndpointName[];

/** Syntax check with zero page side effects: querySelector against a
 *  detached empty fragment throws on invalid selectors and matches nothing. */
export function isValidCssSelector(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > SELECTOR_MAX_LEN) return false;
  try {
    document.createDocumentFragment().querySelector(s);
    return true;
  } catch {
    return false;
  }
}

const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * Structural origin pinning: a value that passes cannot name another host —
 * it must start with `/api/`, and `//` (protocol-relative), any scheme
 * (`:` is rejected outright), `\`, whitespace/control chars, and `..`
 * (including percent-encoded `%2e`) are all rejected. `api/client.ts` only
 * fetches relative paths, so passing values are same-origin by construction.
 * Placeholders must come from the endpoint's known parameter set.
 */
export function isValidEndpointPathTemplate(name: EndpointName, template: unknown): template is string {
  if (typeof template !== "string") return false;
  if (template.length === 0 || template.length > TEMPLATE_MAX_LEN) return false;
  if (!template.startsWith("/api/")) return false;
  if (template.includes("//") || template.includes("\\") || template.includes(":")) return false;
  if (template.includes("..") || /%2e/i.test(template)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(template)) return false;
  const known = new Set<string>(ENDPOINT_PARAMS[name]);
  // Unknown-placeholder sentinel: a space. Unforgeable — the whitespace check
  // above already rejected any template CONTAINING one, so a space after
  // substitution can only be this marker. (Was a raw NUL byte with the same
  // guarantee, which made git treat this file as binary — no diffs/blame on
  // the repo's most security-sensitive module.)
  const stripped = template.replace(PLACEHOLDER_RE, (_m, p: string) =>
    known.has(p) ? "" : " ",
  );
  if (stripped.includes(" ")) return false; // unknown placeholder name
  if (stripped.includes("{") || stripped.includes("}")) return false; // malformed braces
  return true;
}

/** `{param}` → `encodeURIComponent(params[param])`; null when a placeholder
 *  has no value (defensive — write validation makes this unreachable). */
function substituteTemplate(template: string, params: Record<string, string>): string | null {
  let ok = true;
  const out = template.replace(PLACEHOLDER_RE, (_m, p: string) => {
    const v = params[p];
    if (v === undefined) {
      ok = false;
      return "";
    }
    return encodeURIComponent(v);
  });
  return ok ? out : null;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isOverrideSource(v: unknown): v is OverrideSource {
  return v === "user" || v === "repair" || v === "community";
}

// ---------------------------------------------------------------------------
// Default hashes — staleness detection without a history table
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit, hex. Stability across builds matters more than strength —
 *  this detects "the shipped default changed", it authenticates nothing. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Hash of the shipped selector entry (primary + fallbacks) as pure data. */
export function selectorDefaultHash(name: SelectorName): string {
  const e: SelectorEntry = SELECTORS[name];
  return fnv1a(JSON.stringify({ primary: e.primary, fallbacks: e.fallbacks ?? [] }));
}

/**
 * The shipped endpoint builder, rendered as a canonical `{param}` template by
 * invoking it with placeholder arguments (every builder is pure string
 * interpolation, so the output is stable data — safe to hash across builds,
 * unlike `Function.prototype.toString` under minification).
 */
export function endpointDefaultTemplate(name: EndpointName): string {
  const params = ENDPOINT_PARAMS[name];
  const build = Endpoints[name] as unknown as (...args: string[]) => string;
  return build(...params.map((p) => `{${p}}`));
}

export function endpointDefaultHash(name: EndpointName): string {
  return fnv1a(endpointDefaultTemplate(name));
}

// ---------------------------------------------------------------------------
// Stored-file parsing (load + live merge share this; invalid entries drop)
// ---------------------------------------------------------------------------

/**
 * Parse one namespace file from storage. Tolerant by design: a malformed file
 * or entry is dropped with a warning, never thrown — a hand-edited blob must
 * not take the runtime down. Only allowlisted names are read, so
 * hostile keys (`__proto__`, unknown anchors) are structurally ignored.
 */
function parseFile<Name extends string, T>(
  raw: unknown,
  names: readonly Name[],
  sanitize: (name: Name, entry: unknown) => T | null,
  label: string,
): Map<Name, T> {
  const out = new Map<Name, T>();
  if (raw === null || raw === undefined) return out;
  if (!isPlainRecord(raw) || raw["v"] !== 1 || !isPlainRecord(raw["entries"])) {
    console.warn(`[cc] ignoring malformed ${label} overrides file`);
    return out;
  }
  const entries = raw["entries"];
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(entries, name)) continue;
    const clean = sanitize(name, entries[name]);
    if (clean) out.set(name, clean);
    else console.warn(`[cc] dropped invalid ${label} override "${name}"`);
  }
  return out;
}

/** How many entries a namespace file OFFERS (before validation) — the honest
 *  denominator for import reporting. Malformed files offer zero. */
function countFileEntries(raw: unknown): number {
  if (!isPlainRecord(raw) || !isPlainRecord(raw["entries"])) return 0;
  return Object.keys(raw["entries"]).length;
}

/** Shared trailing fields (basedOn/source/at/note/defaultHash), sanitized. */
function sanitizeCommon(raw: Record<string, unknown>): {
  basedOn: string;
  source: OverrideSource;
  at: string;
  note?: string;
  defaultHash?: string;
} {
  const note = typeof raw["note"] === "string" ? raw["note"].slice(0, NOTE_MAX_LEN) : undefined;
  const defaultHash =
    typeof raw["defaultHash"] === "string" && raw["defaultHash"].length <= 16
      ? raw["defaultHash"]
      : undefined;
  return {
    basedOn: typeof raw["basedOn"] === "string" ? raw["basedOn"].slice(0, 64) : "",
    source: isOverrideSource(raw["source"]) ? raw["source"] : "user",
    at: typeof raw["at"] === "string" ? raw["at"].slice(0, 40) : "",
    ...(note !== undefined ? { note } : {}),
    ...(defaultHash !== undefined ? { defaultHash } : {}),
  };
}

function sanitizeSelectorOverride(_name: SelectorName, raw: unknown): SelectorOverride | null {
  if (!isPlainRecord(raw)) return null;
  if (!isValidCssSelector(raw["primary"])) return null;
  let fallbacks: string[] | undefined;
  if (raw["fallbacks"] !== undefined) {
    const fb = raw["fallbacks"];
    if (!Array.isArray(fb) || fb.length > MAX_FALLBACKS || !fb.every(isValidCssSelector)) {
      return null;
    }
    if (fb.length > 0) fallbacks = [...fb];
  }
  return {
    primary: raw["primary"],
    ...(fallbacks ? { fallbacks } : {}),
    ...sanitizeCommon(raw),
  };
}

function sanitizeEndpointOverride(name: EndpointName, raw: unknown): EndpointOverride | null {
  if (!isPlainRecord(raw)) return null;
  if (!isValidEndpointPathTemplate(name, raw["pathTemplate"])) return null;
  return {
    pathTemplate: raw["pathTemplate"],
    ...sanitizeCommon(raw),
  };
}

function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return "0.0.0";
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface OverrideStoreOptions {
  storage: CompanionStorage;
  /** For `selector:degraded` transition events; omit in unit tests. */
  bus?: EventBus;
}

export class OverrideStore {
  readonly #storage: CompanionStorage;
  readonly #bus: EventBus | undefined;

  #selectors = new Map<SelectorName, SelectorOverride>();
  #endpoints = new Map<EndpointName, EndpointOverride>();

  readonly #selectorHealth = new Map<SelectorName, SelectorHealth>();
  readonly #endpointHealth = new Map<EndpointName, SelectorHealth>();
  readonly #sessionStart = Date.now();

  #unsubscribe: (() => void) | null = null;
  #loaded = false;
  readonly #changedCbs = new Set<() => void>();

  /** Trigger state for {@link GENERATION_GATED} anchors — true between
   *  `generation:start` and `generation:end`. Without a bus (bare unit-test
   *  construction) the gate stays closed and gated anchors simply never
   *  accrue misses. */
  #generationActive = false;
  #busUnsubs: Array<() => void> = [];

  constructor(opts: OverrideStoreOptions) {
    this.#storage = opts.storage;
    this.#bus = opts.bus;
    for (const name of SELECTOR_NAMES) this.#selectorHealth.set(name, freshHealth());
    for (const name of ENDPOINT_NAMES) this.#endpointHealth.set(name, freshHealth());
    if (this.#bus) {
      this.#busUnsubs.push(
        this.#bus.on("generation:start", () => {
          this.#generationActive = true;
          // Fresh evidence per active period — leftover misses from the last
          // end-of-generation burst must not count toward this one.
          for (const name of GENERATION_GATED) {
            const h = this.#selectorHealth.get(name);
            if (h) h.missStreak = 0;
          }
        }),
        this.#bus.on("generation:end", () => {
          this.#generationActive = false;
        }),
      );
    }
  }

  /**
   * Boot-load both namespace files and subscribe to `storage.onChanged` for
   * live merge (the popup ↔ content channel precedent): an override written
   * elsewhere takes effect on the very next `query()` — no reload. Idempotent;
   * never throws.
   */
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const [selRaw, epRaw] = await Promise.all([
        this.#storage.getMeta<unknown>(OverrideKey.selectors, null),
        this.#storage.getMeta<unknown>(OverrideKey.endpoints, null),
      ]);
      this.#selectors = parseFile(selRaw, SELECTOR_NAMES, sanitizeSelectorOverride, "selector");
      this.#endpoints = parseFile(epRaw, ENDPOINT_NAMES, sanitizeEndpointOverride, "endpoint");
      this.#unsubscribe = this.#storage.onLocalChanged(
        [OverrideKey.selectors, OverrideKey.endpoints],
        (key, newValue) => {
          if (key === OverrideKey.selectors) {
            this.#selectors = parseFile(newValue, SELECTOR_NAMES, sanitizeSelectorOverride, "selector");
          } else {
            this.#endpoints = parseFile(newValue, ENDPOINT_NAMES, sanitizeEndpointOverride, "endpoint");
          }
          // Own writes land here too (storage.onChanged fires in the writing
          // context as well) — one notification path for every change source.
          this.#notifyChanged();
        },
      );
    } catch (err) {
      console.error("[cc] override store load failed — running on shipped defaults", err);
    }
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const unsub of this.#busUnsubs) unsub();
    this.#busUnsubs = [];
    this.#changedCbs.clear();
  }

  /** See {@link FeatureOverrides.onChanged}. */
  onChanged(cb: () => void): () => void {
    this.#changedCbs.add(cb);
    return () => this.#changedCbs.delete(cb);
  }

  #notifyChanged(): void {
    for (const cb of [...this.#changedCbs]) {
      try {
        cb();
      } catch (err) {
        console.error("[cc] overrides onChanged subscriber threw", err);
      }
    }
  }

  // ---- read accessors (what the resolvers consult) ----

  selectorOverride(name: SelectorName): SelectorOverride | undefined {
    return this.#selectors.get(name);
  }

  endpointOverride(name: EndpointName): EndpointOverride | undefined {
    return this.#endpoints.get(name);
  }

  /** Merged snapshot for a future editor/dashboard. */
  list(): {
    selectors: ReadonlyMap<SelectorName, SelectorOverride>;
    endpoints: ReadonlyMap<EndpointName, EndpointOverride>;
  } {
    return { selectors: new Map(this.#selectors), endpoints: new Map(this.#endpoints) };
  }

  /**
   * Endpoint name → URL, consulting the override template first (re-validated
   * at READ time — defense in depth against a hand-edited storage blob), else
   * the shipped builder. The single door for URL building.
   */
  resolvePath(
    name: EndpointName,
    params: Record<string, string>,
    buildDefault: () => string,
  ): string {
    const o = this.#endpoints.get(name);
    if (!o) return buildDefault();
    if (!isValidEndpointPathTemplate(name, o.pathTemplate)) {
      console.warn(`[cc] endpoint override "${name}" failed read-time validation — using default`);
      return buildDefault();
    }
    const url = substituteTemplate(o.pathTemplate, params);
    if (url === null) {
      console.warn(`[cc] endpoint override "${name}" has an unfilled placeholder — using default`);
      return buildDefault();
    }
    return url;
  }

  // ---- the single validated write path ----

  async set(ns: "selectors", name: SelectorName, input: SelectorOverrideInput): Promise<SetResult>;
  async set(ns: "endpoints", name: EndpointName, input: EndpointOverrideInput): Promise<SetResult>;
  async set(
    ns: "selectors" | "endpoints",
    name: SelectorName | EndpointName,
    input: SelectorOverrideInput | EndpointOverrideInput,
  ): Promise<SetResult> {
    if (!isOverrideSource(input.source)) return { ok: false, reason: "invalid source" };
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > NOTE_MAX_LEN)) {
      return { ok: false, reason: "invalid note" };
    }
    const common = { basedOn: extensionVersion(), source: input.source, at: new Date().toISOString() };

    if (ns === "selectors") {
      if (!SELECTOR_NAMES.includes(name as SelectorName)) {
        return { ok: false, reason: `unknown selector name "${name}"` };
      }
      const i = input as SelectorOverrideInput;
      if (!isValidCssSelector(i.primary)) {
        return { ok: false, reason: "primary is not a valid CSS selector (or exceeds 1 KB)" };
      }
      if (i.fallbacks !== undefined) {
        if (!Array.isArray(i.fallbacks) || i.fallbacks.length > MAX_FALLBACKS) {
          return { ok: false, reason: `fallbacks must be an array of at most ${MAX_FALLBACKS}` };
        }
        for (const fb of i.fallbacks) {
          if (!isValidCssSelector(fb)) {
            return { ok: false, reason: `fallback is not a valid CSS selector: ${String(fb).slice(0, 80)}` };
          }
        }
      }
      const entry: SelectorOverride = {
        primary: i.primary,
        ...(i.fallbacks && i.fallbacks.length > 0 ? { fallbacks: [...i.fallbacks] } : {}),
        ...common,
        ...(i.note ? { note: i.note } : {}),
        defaultHash: selectorDefaultHash(name as SelectorName),
      };
      this.#selectors.set(name as SelectorName, entry);
      await this.#persist("selectors");
      return { ok: true };
    }

    if (!ENDPOINT_NAMES.includes(name as EndpointName)) {
      return { ok: false, reason: `unknown endpoint name "${name}"` };
    }
    const i = input as EndpointOverrideInput;
    if (!isValidEndpointPathTemplate(name as EndpointName, i.pathTemplate)) {
      return {
        ok: false,
        reason:
          "pathTemplate must be a relative /api/… path (no scheme, host, '//', '..', or unknown {placeholders})",
      };
    }
    const entry: EndpointOverride = {
      pathTemplate: i.pathTemplate,
      ...common,
      ...(i.note ? { note: i.note } : {}),
      defaultHash: endpointDefaultHash(name as EndpointName),
    };
    this.#endpoints.set(name as EndpointName, entry);
    await this.#persist("endpoints");
    return { ok: true };
  }

  /** Per-entry deletion — the shipped default is always intact underneath. */
  async reset(ns: "selectors", name: SelectorName): Promise<void>;
  async reset(ns: "endpoints", name: EndpointName): Promise<void>;
  async reset(ns: "selectors" | "endpoints", name: SelectorName | EndpointName): Promise<void> {
    if (ns === "selectors") {
      if (this.#selectors.delete(name as SelectorName)) await this.#persist("selectors");
    } else {
      if (this.#endpoints.delete(name as EndpointName)) await this.#persist("endpoints");
    }
  }

  /**
   * True when the shipped default changed since the override was written
   * (`defaultHash` mismatch) — core now ships its own fix, and the entry
   * deserves a "keep your override or reset?" review. Entries written
   * before hashing existed report false (unknown, never nagged).
   */
  isStale(ns: "selectors", name: SelectorName): boolean;
  isStale(ns: "endpoints", name: EndpointName): boolean;
  isStale(ns: "selectors" | "endpoints", name: SelectorName | EndpointName): boolean {
    if (ns === "selectors") {
      const o = this.#selectors.get(name as SelectorName);
      return o?.defaultHash !== undefined && o.defaultHash !== selectorDefaultHash(name as SelectorName);
    }
    const o = this.#endpoints.get(name as EndpointName);
    return o?.defaultHash !== undefined && o.defaultHash !== endpointDefaultHash(name as EndpointName);
  }

  // ---- export / import (roaming is explicit — files are machine-local) ----

  /** Snapshot of the user's overrides as a portable JSON envelope. */
  exportFile(): OverridesExport {
    return {
      kind: "clenby-overrides",
      exportedAt: new Date().toISOString(),
      coreVersion: extensionVersion(),
      selectors: { v: 1, entries: Object.fromEntries(this.#selectors) },
      endpoints: { v: 1, entries: Object.fromEntries(this.#endpoints) },
    };
  }

  /**
   * Import an {@link OverridesExport}. Entries pass the exact same sanitizers
   * as the boot load (allowlisted names, parse-checked selectors, origin-
   * pinned endpoint templates) — import is untrusted input and never a
   * validation bypass. Valid entries MERGE over current overrides (imported
   * wins per name); invalid ones drop with a warning and are counted.
   */
  async importFile(raw: unknown): Promise<ImportResult> {
    if (!isPlainRecord(raw) || raw["kind"] !== "clenby-overrides") {
      return { ok: false, reason: 'not a Clenby overrides export (missing kind: "clenby-overrides")' };
    }
    const sel = parseFile(raw["selectors"], SELECTOR_NAMES, sanitizeSelectorOverride, "imported selector");
    const ep = parseFile(raw["endpoints"], ENDPOINT_NAMES, sanitizeEndpointOverride, "imported endpoint");
    const offered = countFileEntries(raw["selectors"]) + countFileEntries(raw["endpoints"]);
    const accepted = sel.size + ep.size;
    if (accepted === 0) {
      return {
        ok: false,
        reason: offered === 0 ? "no override entries in this file" : "every entry was dropped by validation",
      };
    }
    for (const [name, entry] of sel) this.#selectors.set(name, entry);
    for (const [name, entry] of ep) this.#endpoints.set(name, entry);
    await this.#persist("selectors");
    await this.#persist("endpoints");
    return { ok: true, selectors: sel.size, endpoints: ep.size, dropped: Math.max(0, offered - accepted) };
  }

  async #persist(ns: "selectors" | "endpoints"): Promise<void> {
    const key = ns === "selectors" ? OverrideKey.selectors : OverrideKey.endpoints;
    const map: ReadonlyMap<string, SelectorOverride | EndpointOverride> =
      ns === "selectors" ? this.#selectors : this.#endpoints;
    const file: OverridesFile<SelectorOverride | EndpointOverride> = {
      v: 1,
      entries: Object.fromEntries(map),
    };
    await this.#storage.setMeta(key, file);
  }

  // ---- health ledger (data/signal only, UI comes later) ----

  /** Fed by `Selectors.#note` on every successful resolution. `evidencePath`
   *  (throttled by the caller) updates the repair flow's last-match evidence;
   *  omitting it keeps the previous capture. */
  noteSelectorMatch(
    name: SelectorName,
    variant: string,
    via: "primary" | "fallback" | "override",
    evidencePath?: string,
  ): void {
    const h = this.#healthOf(this.#selectorHealth, name);
    h.lastMatchedVariant = variant;
    h.lastMatchedAt = Date.now();
    h.matchCount++;
    h.missStreak = 0;
    if (evidencePath !== undefined && evidencePath.length > 0) h.lastMatchPath = evidencePath;
    const next: AnchorState = via === "primary" ? "healthy" : via === "override" ? "override" : "fallback";
    const prev = h.state;
    h.state = next;
    if (next === "fallback" && prev !== "fallback") {
      this.#bus?.emit("selector:degraded", { name, state: "fallback" });
    }
  }

  /**
   * Fed by `Selectors` when no candidate matched. A miss is usually *normal*
   * (`stopButton` only exists while streaming; `assistantTable` only while a
   * table is RENDERED — virtualization unrenders it seconds after it scrolls
   * off), so `broken` requires a miss STREAK plus evidence the anchor should
   * be there:
   *
   * - {@link ALWAYS_PRESENT} anchors: the page has settled.
   * - {@link GENERATION_GATED} anchors: the trigger is ACTIVE (generation is
   *   running) and the anchor hasn't matched within {@link TRANSIENT_GRACE_MS}
   *   — misses at idle don't even accrue. This fixes the false `broken` flag
   *   that used to fire right after every generation, when the stop button
   *   legitimately left the DOM but its pollers kept querying it. A genuinely
   *   drifted stop-button selector IS still caught: the detector's growth
   *   fallback opens the gate, the anchor misses with no recent match, and
   *   the streak flips it mid-generation. (One documented blind spot: the
   *   detector treats mid-generation disappearance as "generation ended", so
   *   a selector that breaks mid-session surfaces only from the next page
   *   load's generation.)
   * - Every other anchor is content-dependent: absence is NEVER evidence of
   *   breakage (see {@link ALWAYS_PRESENT}'s doc). The streak still ticks for
   *   the dashboard, but the state never flips and no alert fires. The old
   *   "matched earlier this session" rule lived here and false-alerted every
   *   time a table/image scrolled out of the render window — removed
   *   2026-07-22.
   */
  noteSelectorMiss(name: SelectorName): void {
    const h = this.#healthOf(this.#selectorHealth, name);
    const gated = GENERATION_GATED.includes(name);
    // Absence while the trigger is inactive is the anchor's normal state —
    // it must not even grow the streak.
    if (gated && !this.#generationActive) return;
    h.missStreak++;
    if (h.state === "broken" || h.missStreak < BROKEN_MISS_STREAK) return;
    let shouldBePresent: boolean;
    if (ALWAYS_PRESENT.includes(name)) {
      // Settled page AND a conversation actually open (see ALWAYS_PRESENT's
      // doc — /new, /settings etc. legitimately lack these anchors). The
      // typeof guard keeps the store constructible in DOM-less unit tests.
      const inConversation =
        typeof location !== "undefined" && location.pathname.startsWith("/chat/");
      shouldBePresent = inConversation && Date.now() - this.#sessionStart > SETTLE_MS;
    } else if (gated) {
      // Gate is open and the streak crossed the threshold — but a match
      // moments ago means the anchor just legitimately left (the burst of
      // polls between button removal and `generation:end`), not breakage.
      shouldBePresent =
        h.lastMatchedAt === null || Date.now() - h.lastMatchedAt > TRANSIENT_GRACE_MS;
    } else {
      // Content-dependent anchor — virtualization makes absence routine.
      shouldBePresent = false;
    }
    if (shouldBePresent) {
      h.state = "broken";
      this.#bus?.emit("selector:degraded", { name, state: "broken" });
    }
  }

  /** Fed by `api/client.ts` on a guard-passing response. */
  noteEndpointSuccess(name: EndpointName, viaOverride: boolean): void {
    const h = this.#healthOf(this.#endpointHealth, name);
    h.lastMatchedVariant = viaOverride ? "override" : "default";
    h.lastMatchedAt = Date.now();
    h.matchCount++;
    h.missStreak = 0;
    h.state = viaOverride ? "override" : "healthy";
  }

  /**
   * Fed by `api/client.ts` on http/schema failure. A response
   * failing its shape guard, or 404/410 on a previously-working endpoint,
   * marks the endpoint `broken`. Other statuses (429/5xx/network blips) only
   * grow the streak — transient trouble is `api:degraded`'s business.
   */
  noteEndpointFailure(name: EndpointName, failure: { kind: "schema" } | { kind: "http"; status: number }): void {
    const h = this.#healthOf(this.#endpointHealth, name);
    h.missStreak++;
    const gone =
      failure.kind === "schema" ||
      ((failure.status === 404 || failure.status === 410) && h.lastMatchedAt !== null);
    if (gone) h.state = "broken";
  }

  selectorHealth(): ReadonlyMap<SelectorName, SelectorHealth> {
    return this.#selectorHealth;
  }

  endpointHealth(): ReadonlyMap<EndpointName, SelectorHealth> {
    return this.#endpointHealth;
  }

  #healthOf<Name extends string>(map: Map<Name, SelectorHealth>, name: Name): SelectorHealth {
    let h = map.get(name);
    if (!h) {
      h = freshHealth();
      map.set(name, h);
    }
    return h;
  }
}

function freshHealth(): SelectorHealth {
  return {
    state: "unknown",
    lastMatchedVariant: null,
    lastMatchedAt: null,
    matchCount: 0,
    missStreak: 0,
    lastMatchPath: null,
  };
}
