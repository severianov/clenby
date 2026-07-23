/**
 * The single wrapper over `browser.storage`. No other
 * module touches the storage APIs.
 *
 * - `storage.sync`  — settings only ({ activePresetId, tweaks, panelPos,
 *   onboarding, … }). Tiny, roams with the profile.
 * - `storage.local` — per-conversation data (pins, notes, todos, highlights,
 *   recorded per-message models), keyed `conv:<convId>:<kind>` via
 *   {@link convStorageKey}. These can grow large; sync would blow quota.
 * - One-time migration: legacy versions persisted to the page's `localStorage`
 *   (`cc-notes-*`, `cc-notes2-*`, `cc-notes3-*`, `cc-pins-*`, `cc-hls-*`,
 *   `cc-undo-delay`, `cc-tips-off`) which content scripts can read
 *   (same-origin DOM storage). On first run we import everything into
 *   extension storage so existing user data survives.
 */

import { browser } from "wxt/browser";
import type { ThemeModeSetting, ThemeTweaks } from "@/theme/tokens";
import {
  LEGACY_LOCALSTORAGE_PREFIXES,
  MetaKey,
  SettingsKey,
  convStorageKey,
  type ConvKind,
} from "./storage-keys";

// ---------------------------------------------------------------------------
// Value shapes
// ---------------------------------------------------------------------------

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  /** ISO timestamp of creation. */
  at: string;
}

export interface HighlightRecord {
  id: string;
  /** Message uuid the highlight lives in. `null` when the dom-matcher probe
   *  had not resolved yet at creation time (wrap first, store null,
   *  resolve later) — the highlights feature back-fills it. */
  uuid: string | null;
  /** The highlighted text (used to re-apply marks after re-renders). */
  text: string;
  /** ISO timestamp of creation (kept through the
   *  legacy `cc-hls-<convId>` migration). Absent on pre-fix records. */
  at?: string;
}

/** An autosaved composer draft (draft-keeper). */
export interface DraftRecord {
  /** The composer's plain text at save time. */
  text: string;
  /** ISO timestamp of the save. */
  at: string;
}

/** Per-conversation data kinds and their value types. */
export interface ConvDataMap {
  /** Pinned answer message uuids. */
  pins: string[];
  /** Free-form scratchpad text. */
  notes: string;
  todos: TodoItem[];
  highlights: HighlightRecord[];
  /** Message uuid → model id recorded at send time (API has no per-message model). */
  models: Record<string, string>;
  /** Autosaved composer draft (draft-keeper). */
  draft: DraftRecord;
  /** live-checklists: `<messageUuid>#<listIndex>` → checked item indices. */
  checklists: Record<string, number[]>;
}

const CONV_DEFAULTS: { readonly [K in ConvKind]: ConvDataMap[K] } = {
  pins: [],
  notes: "",
  todos: [],
  highlights: [],
  models: {},
  draft: { text: "", at: "" },
  checklists: {},
};

/** Global settings — stored in `storage.sync`. */
export interface CompanionSettings {
  /** Active theme preset id; "default" = theming off. */
  activePresetId: string;
  /** Light/dark for themed presets — a hard two-way choice (no auto since
   *  2026-07-22). Legacy stored "auto" (or any sync junk) is resolved to
   *  claude.ai's current appearance by getSettings, so old installs keep
   *  following claude until the user picks a side. The Off preset ignores
   *  this and always follows the page. */
  themeMode: ThemeModeSetting;
  /** User fine-tuning merged over the active preset (v1 spec). */
  tweaks: ThemeTweaks;
  /** Outline panel position; null = default docking. */
  panelPos: { left: number; top: number } | null;
  onboarding: {
    /** Ambient tip line dismissed (legacy `cc-tips-off`). */
    tipsOff: boolean;
    /** Spotlight tour completed (post-Tier-3 polish). */
    tourDone: boolean;
  };
  /** Undo-send delay in seconds; 0 = disabled (legacy `cc-undo-delay`). */
  undoDelaySeconds: number;
  /** Enter inserts a newline, Ctrl/Cmd+Enter sends (default OFF — claude.ai's
   *  native Enter-to-send stays untouched). */
  enterToNewline: boolean;
  /** Secret detection — the status bar scans the draft for keys/passwords
   *  and shows an inline red warning before you send (Trust; default ON —
   *  detection is pure/local, see features/status-bar/secret-guard.ts). */
  secretGuardOn: boolean;
  /** "Looks cut off — Continue" affordance on truncated last answers
   *  (Output repair; default ON). */
  truncationGuardOn: boolean;
  /** Display-only re-render of answers a broken code fence swallowed
   *  (Output repair; default ON). */
  fenceFixerOn: boolean;
  /** Snapshot answers before retry/regenerate; expose the saved version on
   *  the rerolled answer (Output repair; default ON). */
  regenSafetyNetOn: boolean;
  /** Toolbar on markdown tables in answers — copy TSV, download CSV, expand
   *  into a sortable overlay (Data & media; default ON). */
  tableToolbarOn: boolean;
  /** Recompute simple arithmetic claims in answers and mark results that
   *  don't add up (Trust++; default OFF — an opt-in checking aid). */
  mathCheckerOn: boolean;
  /** Tickable checkboxes on Claude's step lists — numbered lists, `- [ ]`
   *  task lists, "Step N:" paragraphs — with per-chat memory of what's done
   *  (Delight & memory; default ON). */
  liveChecklistsOn: boolean;
}

export const DEFAULT_SETTINGS: CompanionSettings = {
  activePresetId: "default",
  // Placeholder only — getSettings resolves an unset/legacy themeMode to
  // claude.ai's live appearance (this static value is reached solely in
  // DOM-less contexts, which never render themes).
  themeMode: "dark",
  tweaks: {},
  panelPos: null,
  onboarding: { tipsOff: false, tourDone: false },
  undoDelaySeconds: 0,
  enterToNewline: false,
  secretGuardOn: true,
  truncationGuardOn: true,
  fenceFixerOn: true,
  regenSafetyNetOn: true,
  tableToolbarOn: true,
  mathCheckerOn: false,
  liveChecklistsOn: true,
};

const SETTINGS_KEY_BY_FIELD: { readonly [K in keyof CompanionSettings]: string } = {
  activePresetId: SettingsKey.activePresetId,
  themeMode: SettingsKey.themeMode,
  tweaks: SettingsKey.tweaks,
  panelPos: SettingsKey.panelPos,
  onboarding: SettingsKey.onboarding,
  undoDelaySeconds: SettingsKey.undoDelaySeconds,
  enterToNewline: SettingsKey.enterToNewline,
  secretGuardOn: SettingsKey.secretGuardOn,
  truncationGuardOn: SettingsKey.truncationGuardOn,
  fenceFixerOn: SettingsKey.fenceFixerOn,
  regenSafetyNetOn: SettingsKey.regenSafetyNetOn,
  tableToolbarOn: SettingsKey.tableToolbarOn,
  mathCheckerOn: SettingsKey.mathCheckerOn,
  liveChecklistsOn: SettingsKey.liveChecklistsOn,
};

// ---------------------------------------------------------------------------
// The storage service
// ---------------------------------------------------------------------------

export class CompanionStorage {
  // ---- settings (storage.sync) ----

  async getSettings(): Promise<CompanionSettings> {
    const keys = Object.values(SETTINGS_KEY_BY_FIELD);
    let raw: Record<string, unknown>;
    try {
      raw = await browser.storage.sync.get(keys);
    } catch (err) {
      console.error("[cc] storage.sync.get failed, using defaults", err);
      return { ...DEFAULT_SETTINGS };
    }
    const out: CompanionSettings = structuredClone(DEFAULT_SETTINGS);
    for (const field of Object.keys(SETTINGS_KEY_BY_FIELD) as Array<keyof CompanionSettings>) {
      const v = raw[SETTINGS_KEY_BY_FIELD[field]];
      if (v !== undefined) {
        (out as Record<keyof CompanionSettings, unknown>)[field] = v;
      }
    }
    // themeMode is a hard two-way choice since 2026-07-22. Unset installs and
    // legacy "auto" (still in sync storage) resolve to claude.ai's CURRENT
    // appearance — old behavior preserved until the user picks a side (their
    // pick then persists as a plain "light"/"dark"). Read inline off html —
    // importing theme/engine here would cycle (engine → compile → selectors
    // → overrides → storage).
    if (out.themeMode !== "light" && out.themeMode !== "dark") {
      out.themeMode =
        typeof document !== "undefined" &&
        document.documentElement.getAttribute("data-mode") === "light"
          ? "light"
          : "dark";
    }
    return out;
  }

  async setSetting<K extends keyof CompanionSettings>(
    field: K,
    value: CompanionSettings[K],
  ): Promise<void> {
    try {
      await browser.storage.sync.set({ [SETTINGS_KEY_BY_FIELD[field]]: value });
    } catch (err) {
      console.error(`[cc] storage.sync.set(${String(field)}) failed`, err);
    }
  }

  /**
   * Subscribe to settings changes (the popup ↔ content channel — no runtime
   * messaging). Returns an unsubscribe function.
   */
  onSettingsChanged(cb: (settings: CompanionSettings) => void): () => void {
    const keySet = new Set<string>(Object.values(SETTINGS_KEY_BY_FIELD));
    const listener = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      area: string,
    ) => {
      if (area !== "sync") return;
      if (!Object.keys(changes).some((k) => keySet.has(k))) return;
      void this.getSettings().then(cb);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }

  // ---- per-conversation data (storage.local) ----

  async getConv<K extends ConvKind>(convId: string, kind: K): Promise<ConvDataMap[K]> {
    const key = convStorageKey(convId, kind);
    try {
      const raw = await browser.storage.local.get(key);
      const v = raw[key];
      if (v === undefined || v === null) return structuredClone(CONV_DEFAULTS[kind]);
      return v as ConvDataMap[K];
    } catch (err) {
      console.error(`[cc] storage.local.get(${key}) failed`, err);
      return structuredClone(CONV_DEFAULTS[kind]);
    }
  }

  async setConv<K extends ConvKind>(
    convId: string,
    kind: K,
    value: ConvDataMap[K],
  ): Promise<void> {
    const key = convStorageKey(convId, kind);
    try {
      await browser.storage.local.set({ [key]: value });
    } catch (err) {
      console.error(`[cc] storage.local.set(${key}) failed`, err);
    }
  }

  async removeConv(convId: string, kind: ConvKind): Promise<void> {
    const key = convStorageKey(convId, kind);
    try {
      await browser.storage.local.remove(key);
    } catch (err) {
      console.error(`[cc] storage.local.remove(${key}) failed`, err);
    }
  }

  // ---- bookkeeping (storage.local) ----

  async getMeta<T>(key: string, fallback: T): Promise<T> {
    try {
      const raw = await browser.storage.local.get(key);
      const v = raw[key];
      return v === undefined ? fallback : (v as T);
    } catch {
      return fallback;
    }
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    try {
      await browser.storage.local.set({ [key]: value });
    } catch (err) {
      console.error(`[cc] storage.local.set(${key}) failed`, err);
    }
  }

  /**
   * Subscribe to changes of specific `storage.local` keys — the override
   * layer's live-merge channel (same popup ↔ content precedent as
   * {@link onSettingsChanged}; browser.storage APIs stay confined to this
   * module). Returns an unsubscribe function.
   */
  onLocalChanged(
    keys: readonly string[],
    cb: (key: string, newValue: unknown) => void,
  ): () => void {
    const keySet = new Set(keys);
    const listener = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      area: string,
    ) => {
      if (area !== "local") return;
      for (const [key, change] of Object.entries(changes)) {
        if (keySet.has(key)) cb(key, change.newValue);
      }
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }

  // ---- scoping ----

  /**
   * Build the pre-scoped view a FeatureContext carries. `convIdProvider`
   * resolves lazily so session-scope features always see the *current*
   * conversation; conversation-scope features get a fixed id from the runtime.
   */
  scoped(convIdProvider: () => string | null): ScopedStorage {
    return new ScopedStorage(this, convIdProvider);
  }

  // ---- one-time localStorage migration ----

  /**
   * Import legacy page-localStorage data into extension storage.
   * Idempotent: guarded by {@link MetaKey.migrationDone}. Never throws — a
   * failed migration must not take the runtime down.
   */
  async migrateLegacyLocalStorage(): Promise<void> {
    try {
      const done = await this.getMeta<boolean>(MetaKey.migrationDone, false);
      if (done) return;

      const ls = window.localStorage;
      let imported = 0;

      // Per-conversation keys. List order matters: cc-notes3-* (the final
      // todos store) comes after cc-notes2-* and overwrites it.
      for (const { prefix, kind } of LEGACY_LOCALSTORAGE_PREFIXES) {
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i);
          if (!key || !key.startsWith(prefix)) continue;
          const convId = key.slice(prefix.length);
          if (!convId) continue;
          const raw = ls.getItem(key);
          if (raw === null) continue;

          if (kind === "notes") {
            // Notes were stored as a raw string.
            await this.setConv(convId, "notes", raw);
            imported++;
          } else {
            const parsed = parseJson(raw);
            if (parsed !== undefined) {
              await this.setConv(convId, kind, parsed as ConvDataMap[typeof kind]);
              imported++;
            }
          }
        }
      }

      // Global keys.
      const undoDelay = ls.getItem("cc-undo-delay");
      if (undoDelay !== null) {
        const n = Number.parseInt(undoDelay, 10);
        if (Number.isFinite(n) && n >= 0) {
          await this.setSetting("undoDelaySeconds", n);
          imported++;
        }
      }
      const tipsOff = ls.getItem("cc-tips-off");
      if (tipsOff !== null) {
        await this.setSetting("onboarding", {
          ...DEFAULT_SETTINGS.onboarding,
          tipsOff: tipsOff === "1",
        });
        imported++;
      }
      // Note: legacy versions never persisted theme / text-size to
      // localStorage — nothing to import.

      await this.setMeta(MetaKey.migrationDone, true);
      if (imported > 0) console.info(`[cc] migrated ${imported} legacy localStorage entries`);
    } catch (err) {
      console.error("[cc] legacy localStorage migration failed (will retry next load)", err);
    }
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Scoped views
// ---------------------------------------------------------------------------

/** What `ctx.storage` exposes to a feature. */
export class ScopedStorage {
  readonly #store: CompanionStorage;
  readonly #convIdProvider: () => string | null;
  readonly conv: ConvScopedStorage;

  constructor(store: CompanionStorage, convIdProvider: () => string | null) {
    this.#store = store;
    this.#convIdProvider = convIdProvider;
    this.conv = new ConvScopedStorage(store, convIdProvider);
  }

  get convId(): string | null {
    return this.#convIdProvider();
  }

  getSettings(): Promise<CompanionSettings> {
    return this.#store.getSettings();
  }

  setSetting<K extends keyof CompanionSettings>(
    field: K,
    value: CompanionSettings[K],
  ): Promise<void> {
    return this.#store.setSetting(field, value);
  }

  onSettingsChanged(cb: (settings: CompanionSettings) => void): () => void {
    return this.#store.onSettingsChanged(cb);
  }

  // ---- bookkeeping passthroughs (storage.local) ----

  getMeta<T>(key: string, fallback: T): Promise<T> {
    return this.#store.getMeta(key, fallback);
  }

  setMeta(key: string, value: unknown): Promise<void> {
    return this.#store.setMeta(key, value);
  }

  /** Read one per-conversation record for an ARBITRARY conversation — the
   *  Claude Code bridge's read tools (get_pins/notes/highlights by id).
   *  READ-ONLY; everyday per-conversation access stays on `conv` (bound to the
   *  current chat). */
  getConv<K extends ConvKind>(convId: string, kind: K): Promise<ConvDataMap[K]> {
    return this.#store.getConv(convId, kind);
  }

  /** Remove one per-conversation record for an ARBITRARY conversation —
   *  draft-keeper's cross-conversation prune. Everyday per-conversation
   *  access stays on `conv` (bound to the current chat). */
  removeConv(convId: string, kind: ConvKind): Promise<void> {
    return this.#store.removeConv(convId, kind);
  }
}

/** `ctx.storage.conv` — bound to the current conversation. Reads return the
 *  kind's default when there is no current conversation; writes are dropped
 *  with a debug log (never an exception). */
export class ConvScopedStorage {
  readonly #store: CompanionStorage;
  readonly #convIdProvider: () => string | null;

  constructor(store: CompanionStorage, convIdProvider: () => string | null) {
    this.#store = store;
    this.#convIdProvider = convIdProvider;
  }

  async get<K extends ConvKind>(kind: K): Promise<ConvDataMap[K]> {
    const convId = this.#convIdProvider();
    if (!convId) return structuredClone(CONV_DEFAULTS[kind]);
    return this.#store.getConv(convId, kind);
  }

  async set<K extends ConvKind>(kind: K, value: ConvDataMap[K]): Promise<void> {
    const convId = this.#convIdProvider();
    if (!convId) {
      console.debug(`[cc] dropped conv write (${kind}) — no current conversation`);
      return;
    }
    return this.#store.setConv(convId, kind, value);
  }

  async remove(kind: ConvKind): Promise<void> {
    const convId = this.#convIdProvider();
    if (!convId) return;
    return this.#store.removeConv(convId, kind);
  }
}
