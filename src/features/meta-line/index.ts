/**
 * Meta line — Tier 2 rider, conversation scope.
 *
 * Robust DOM↔API matching + a theme-independent `.cc-meta` font (the
 * stamp must NOT inherit the theme's serif/mono; companion.css hardens the
 * `.cc-meta-area` font with !important) + friendly model labels.
 *
 * LANDMINES:
 * - Muted right-aligned "Jul 20 · 10:42 PM · Opus 4.8" INSIDE each answer's
 *   bottom — requested via ctx.decorations.metaSlot (thread-only guard is
 *   decorations' job). Replaced hover tooltips + floating badge; the
 *   read-time badge was deliberately REMOVED — do not resurrect.
 * - Node→uuid via ctx.matcher.uuidForElement (40-char probes at 0/40/70 %,
 *   companion chars stripped — first-N-chars FAILS on tool-block openers).
 * - Timestamp format: shared/time.messageStamp.
 * - Model tag: the API has NO per-message model. The active model is read
 *   from the model-picker button when a generation starts and recorded keyed
 *   by the new message's uuid (resolved on `conversation:updated`) into
 *   ctx.storage.conv "models". Messages without a recorded model fall back
 *   to the conversation-level model.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { messageStamp } from "@/shared/time";

const OWNER = "meta-line";
const SWEEP_MS = 1200;

/** Known model ids → display names, else prettify the id. */
const FRIENDLY: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-5": "Opus 4.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-fable-5": "Fable 5",
  "claude-haiku-4-5": "Haiku 4.5",
};

export function friendlyModel(model: string | null | undefined): string {
  if (!model) return "";
  const known = FRIENDLY[model];
  if (known) return known;
  return model
    .replace(/^claude-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export const metaLine: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    /** Message uuid → model recorded at send time (ctx.storage.conv "models"). */
    let models: Record<string, string> = {};
    /** Model-picker text captured when a generation starts; resolved to the
     *  new assistant message's uuid once the refetched index arrives. */
    let pendingModel: string | null = null;

    const readPickerModel = (): string | null => {
      const btn = ctx.selectors.query("modelPicker");
      const text = btn?.textContent?.trim();
      return text ? text : null;
    };

    const sweep = (): void => {
      const index = ctx.conversation.current();
      if (!index) return;
      for (const el of ctx.selectors.queryAll<HTMLElement>("assistantMessage")) {
        const slot = ctx.decorations.metaSlot(el, OWNER);
        if (!slot) continue; // outside the thread (artifact/document viewer)
        const uuid = ctx.matcher.uuidForElement(el, "assistant");
        if (!uuid) continue; // e.g. still streaming — not in the index yet
        const message = index.messages.find((m) => m.uuid === uuid);
        if (!message?.createdAt) continue; // DOM-fallback entries carry no time
        const stamp = messageStamp(message.createdAt);
        if (!stamp) continue;
        const model = friendlyModel(models[uuid] ?? index.model);
        const text = model ? `${stamp} · ${model}` : stamp;
        if (slot.textContent !== text) slot.textContent = text;
      }
    };

    /** Attach the captured send-time model to the newest assistant message
     *  that has no recorded model yet, then persist. */
    const resolvePending = async (): Promise<void> => {
      if (!pendingModel) return;
      const index = ctx.conversation.current();
      if (!index) return;
      const lastAnswer = [...index.messages].reverse().find((m) => m.sender === "assistant");
      if (!lastAnswer || lastAnswer.uuid.startsWith("dom-")) return;
      if (models[lastAnswer.uuid] === undefined) {
        models = { ...models, [lastAnswer.uuid]: pendingModel };
        await ctx.storage.conv.set("models", models);
      }
      pendingModel = null;
      sweep();
    };

    void ctx.storage.conv.get("models").then((m) => {
      if (ctx.signal.aborted) return;
      models = m;
      sweep();
    });

    ctx.on("generation:start", () => {
      pendingModel = readPickerModel();
    });
    ctx.on("conversation:updated", () => {
      void resolvePending();
    });
    ctx.on("conversation:indexed", () => sweep());

    ctx.setInterval(sweep, SWEEP_MS);
    sweep();
  },
};
