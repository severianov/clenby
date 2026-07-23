/**
 * Pins — Tier 2, conversation scope.
 *
 * State + persistence ONLY: the standalone 📌 gutter button was removed
 * deliberately — the answer hover-toolbar's Pin action is the
 * single entry point, so the redundant per-message button (and its
 * gutter-slot/sweep machinery) is gone. Everything else carries over:
 *
 * - The toolbar's Pin action lands here via bus "ui:pin-toggle" (features
 *   never import each other): toggle the uuid in the in-memory Set, then
 *   persist.
 * - Per-conversation persistence: ctx.storage.conv key "pins", stored as a
 *   string[] of answer uuids — migrated by core/storage from the legacy
 *   `cc-pins-<convId>` localStorage.
 * - Outline/export integration without imports: pins persists to storage
 *   and emits "conversation:updated" on the bus; the outline rebuilds on that
 *   event and reads the "pins" key to render the gold 📌 Pinned group, and
 *   export's "pinned only" scope reads the same key.
 * - Live pin-state fan-out: emits "pins:changed" with the FULL uuid set once
 *   after the per-conversation set loads and again on every toggle, so
 *   bus-coupled consumers (the answer-toolbar's Pin button) can paint
 *   pinned/unpinned state without re-reading storage mid-write.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";

export const pins: FeatureModule = {
  id: "pins",
  tier: 2,
  scope: "conversation",

  async mount(ctx: FeatureContext) {
    const pinned = new Set<string>(await ctx.storage.conv.get("pins"));
    // Make sure the API index (uuid source) is being built.
    void ctx.conversation.ensure();

    /** The one pin-state broadcast — always the full set, never a delta. */
    const emitChanged = (): void => {
      ctx.bus.emit("pins:changed", { pinned: [...pinned] });
    };

    const persist = (): void => {
      void ctx.storage.conv.set("pins", [...pinned]);
      emitChanged();
      const convId = ctx.storage.convId;
      if (convId) ctx.bus.emit("conversation:updated", { convId });
    };

    // The answer-toolbar's Pin action (bus event — features never import
    // each other): toggle + persist; outline/export pick the change up
    // through storage + "conversation:updated".
    ctx.on("ui:pin-toggle", ({ uuid }) => {
      if (pinned.has(uuid)) pinned.delete(uuid);
      else pinned.add(uuid);
      persist();
    });

    // Publish the loaded set once so already-mounted consumers sync up
    // (consumers that mount later cold-start from the same storage key).
    emitChanged();
  },
};
