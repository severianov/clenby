/**
 * Boot sequence + feature registry execution + conversation-scope remounting
 *.
 *
 * Boot order: storage → overrides (self-healing layer, loads before anything
 * resolves an anchor) → api → bus → selectors → (theme mounts as the first
 * session feature) → navigation → conversation-store → generation → composer →
 * matcher → decorations → ui/root, then features in registry order.
 *
 * On `nav:conversation-changed`: every `scope:"conversation"` feature is
 * unmounted (feature unmount() → ctx resource disposal → data-cc-owner DOM
 * sweep) and remounted with a FRESH context whose storage is bound to the new
 * conversation id. Per-conversation state structurally cannot leak across
 * chats.
 */

import { ClaudeApi } from "@/api/client";
import { EventBus } from "./event-bus";
import { CompanionStorage } from "./storage";
import { OverrideStore } from "./overrides";
import { Selectors } from "./selectors";
import { NavigationWatcher } from "./navigation";
import { ConversationStore } from "./conversation-store";
import { DomMatcher } from "./dom-matcher";
import { GenerationDetector } from "./generation";
import { ComposerService } from "./composer";
import { DecorationsService } from "./decorations";
import { ensureRoot } from "@/ui/root";
import {
  createFeatureContext,
  ManagedResources,
  type FeatureModule,
  type FeatureServices,
} from "./feature";
import { FEATURES } from "./registry";

interface MountedFeature {
  feature: FeatureModule;
  resources: ManagedResources;
}

export class CompanionRuntime {
  readonly #bus = new EventBus();
  readonly #storage = new CompanionStorage();
  /** Self-healing selector/endpoint override layer + health ledger. Loaded in
   *  boot() before any feature mounts; a no-op until an override is stored. */
  readonly #overrides = new OverrideStore({ storage: this.#storage, bus: this.#bus });
  readonly #selectors = new Selectors(this.#overrides);
  readonly #api = new ClaudeApi({ bus: this.#bus, overrides: this.#overrides });
  readonly #navigation = new NavigationWatcher(this.#bus);
  readonly #conversation = new ConversationStore({
    api: this.#api,
    bus: this.#bus,
    navigation: this.#navigation,
    selectors: this.#selectors,
  });
  readonly #matcher = new DomMatcher({ store: this.#conversation, selectors: this.#selectors });
  readonly #generation = new GenerationDetector({ bus: this.#bus, selectors: this.#selectors });
  readonly #composer = new ComposerService({ bus: this.#bus, selectors: this.#selectors });
  readonly #decorations = new DecorationsService({ selectors: this.#selectors });

  #root: HTMLElement | null = null;
  #mounted = new Map<string, MountedFeature>();
  #booted = false;

  async boot(): Promise<void> {
    if (this.#booted || document.getElementById("cc-root")) return;
    this.#booted = true;

    // One-time import of legacy page-localStorage data (pins/notes/
    // highlights/todos + undo delay + tips flag) — must run before features
    // read their stores.
    await this.#storage.migrateLegacyLocalStorage();

    // Self-healing override layer: load stored selector/endpoint overrides
    // and subscribe for live merge BEFORE any service resolves an anchor.
    // With nothing stored (the default), resolution is the shipped defaults.
    await this.#overrides.load();

    this.#root = ensureRoot();

    // Core producers, in boot order.
    this.#navigation.start();
    this.#conversation.start();
    this.#generation.start();
    this.#composer.start();

    // Session features mount once (theme engine is first in registry order,
    // so --cc-* tokens exist before any UI renders).
    for (const feature of FEATURES) {
      if (feature.scope === "session") await this.#mount(feature, null);
    }

    // Conversation features mount for the current chat (if any) and remount
    // on every switch.
    const convId = this.#navigation.currentConvId;
    if (convId) {
      this.#conversation.ensure().catch((err) => {
        console.warn("[cc] initial conversation index failed (features use DOM fallback)", err);
      });
      for (const feature of FEATURES) {
        if (feature.scope === "conversation") await this.#mount(feature, convId);
      }
    }

    this.#bus.on("nav:conversation-changed", ({ convId: next }) => {
      this.#remountConversationFeatures(next).catch((err) => {
        console.error("[cc] conversation remount failed (contained)", err);
      });
    });

    // Boot summary. Conversation-scoped features intentionally stay unmounted
    // until a chat is open — that is idle, not failure, so say so.
    const conversationScoped = FEATURES.filter((f) => f.scope === "conversation").length;
    const waiting = convId ? 0 : conversationScoped;
    console.info(
      waiting > 0
        ? `[cc] runtime booted — ${this.#mounted.size}/${FEATURES.length} active (${waiting} conversation-scoped, waiting for a chat)`
        : `[cc] runtime booted — ${this.#mounted.size}/${FEATURES.length} active`,
    );
  }

  /** Tear the whole companion down in this tab. Called when the extension
   *  context is invalidated (extension reloaded/updated while the tab stayed
   *  open) — the orphaned script must go quiet instead of error-spamming the
   *  extensions card until the user refreshes. Idempotent. */
  shutdown(): void {
    if (!this.#booted) return;
    this.#booted = false;
    for (const id of [...this.#mounted.keys()]) this.#unmount(id);
    this.#navigation.stop();
    this.#conversation.stop();
    this.#generation.stop();
    this.#composer.stop();
    this.#overrides.dispose();
    this.#root?.remove();
    this.#root = null;
    document.getElementById("cc-companion")?.remove();
    console.info("[cc] extension was reloaded — companion disabled in this tab; refresh to re-enable");
  }

  async #remountConversationFeatures(convId: string | null): Promise<void> {
    for (const feature of FEATURES) {
      if (feature.scope !== "conversation") continue;
      this.#unmount(feature.id);
    }
    if (!convId) return;
    for (const feature of FEATURES) {
      if (feature.scope !== "conversation") continue;
      await this.#mount(feature, convId);
    }
  }

  /** Mount one feature. A throwing mount is logged and skipped — it never
   *  takes the runtime down. */
  async #mount(feature: FeatureModule, convId: string | null): Promise<void> {
    if (this.#mounted.has(feature.id)) {
      console.warn(`[cc] feature "${feature.id}" already mounted — skipping`);
      return;
    }
    const resources = new ManagedResources();
    // Conversation features get storage frozen to their conversation; session
    // features resolve the current conversation lazily.
    const convIdProvider =
      feature.scope === "conversation" && convId !== null
        ? () => convId
        : () => this.#navigation.currentConvId;

    const services: FeatureServices = {
      bus: this.#bus,
      api: this.#api,
      storage: this.#storage.scoped(convIdProvider),
      conversation: this.#conversation,
      matcher: this.#matcher,
      composer: this.#composer,
      selectors: this.#selectors,
      decorations: this.#decorations,
      overrides: this.#overrides,
      root: this.#root ?? ensureRoot(),
    };

    try {
      await feature.mount(createFeatureContext(services, resources));
      this.#mounted.set(feature.id, { feature, resources });
    } catch (err) {
      console.error(`[cc] feature "${feature.id}" failed to mount — skipped`, err);
      resources.dispose();
      this.#sweepOwnedNodes(feature.id);
    }
  }

  #unmount(featureId: string): void {
    const entry = this.#mounted.get(featureId);
    if (!entry) return;
    this.#mounted.delete(featureId);
    try {
      entry.feature.unmount?.();
    } catch (err) {
      console.error(`[cc] feature "${featureId}" unmount() threw`, err);
    }
    entry.resources.dispose();
    this.#sweepOwnedNodes(featureId);
  }

  /** Safety net: teardown is guaranteed even if a feature forgot a node. */
  #sweepOwnedNodes(featureId: string): void {
    for (const el of document.querySelectorAll(`[data-cc-owner="${featureId}"]`)) {
      el.remove();
    }
  }
}
