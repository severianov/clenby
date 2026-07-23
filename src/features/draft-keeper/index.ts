/**
 * Draft keeper — Composer. Conversation scope.
 *
 * Autosaves the composer's text to storage.local PER CONVERSATION (drafts are
 * conversation data, not settings) so an unsent draft survives refresh, crash,
 * and navigation. On mount, if the composer is EMPTY and a saved draft exists,
 * the draft is restored straight into the composer (v1: silent restore, no
 * offer UI) — but never over text the user is already typing.
 *
 * Own-UI-only discipline: this feature renders nothing and never touches
 * message DOM; its single composer write is the restore, via
 * ctx.composer.insertText (the ONE sanctioned ProseMirror writer).
 *
 * Save path: composer input (document capture — survives React re-renders of
 * the contenteditable) debounced ~400 ms via a token guard (ctx timeouts are
 * not individually cancellable). The core draft poll (`composer:draft-changed`,
 * 600 ms) is the backstop that also catches NON-input clears — most
 * importantly claude emptying the composer after a SEND, which fires no input
 * event. The rule for clearing is one transition: known-text → empty ⇒ the
 * message left the composer (sent or deliberately deleted) ⇒ the saved draft
 * is removed. This deliberately does not fight undo-send: during its countdown
 * the text is still in the composer, so nothing clears until the send actually
 * fires.
 *
 * Growth cap: a `cc:draftIndex` meta record (convId → last-saved ms) is
 * updated on every save; when it exceeds MAX_DRAFTS the oldest drafts are
 * pruned (storage.local removes), so abandoned drafts never accumulate
 * unbounded.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { MetaKey } from "@/core/storage-keys";

const OWNER = "draft-keeper";

const SAVE_DEBOUNCE_MS = 400;
/** Restore/mount poll cadence — the composer may not exist yet at mount. */
const RESTORE_POLL_MS = 400;
/** Stop waiting for a restorable composer after this long. */
const RESTORE_GIVE_UP_MS = 15_000;
/** Hard cap per saved draft — keeps far under storage.local item quotas. */
const MAX_DRAFT_CHARS = 60_000;
/** Keep at most this many conversations' drafts (oldest pruned first). */
const MAX_DRAFTS = 30;

export const draftKeeper: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    const convId = ctx.storage.convId;
    if (!convId) return; // new-chat page has no id to key a draft under

    // ---- state ---------------------------------------------------------------
    /** Restore decision made (restored, nothing to restore, or gave up). Saves
     *  are armed only after this so a pre-restore "" can never wipe the store. */
    let settled = false;
    /** We have seen a non-empty draft — the guard for the clear-on-empty rule. */
    let hadText = false;
    /** Last text persisted (skip no-op writes). */
    let persisted: string | null = null;
    /** Loaded stored draft; null until the async read lands. */
    let storedText: string | null = null;
    /** Debounce token — a newer input invalidates older pending saves. */
    let saveToken = 0;
    /** True while a scheduled save has not run yet (flush-on-unmount check). */
    let savePending = false;
    const mountedAt = Date.now();

    // ---- persistence ---------------------------------------------------------
    const touchIndexAndPrune = async (): Promise<void> => {
      const index = await ctx.storage.getMeta<Record<string, number>>(MetaKey.draftIndex, {});
      index[convId] = Date.now();
      const ids = Object.keys(index);
      if (ids.length > MAX_DRAFTS) {
        ids.sort((a, b) => (index[a] ?? 0) - (index[b] ?? 0));
        for (const old of ids.slice(0, ids.length - MAX_DRAFTS)) {
          if (old === convId) continue;
          await ctx.storage.removeConv(old, "draft");
          delete index[old];
        }
      }
      await ctx.storage.setMeta(MetaKey.draftIndex, index);
    };

    const dropFromIndex = async (): Promise<void> => {
      const index = await ctx.storage.getMeta<Record<string, number>>(MetaKey.draftIndex, {});
      if (!(convId in index)) return;
      delete index[convId];
      await ctx.storage.setMeta(MetaKey.draftIndex, index);
    };

    const clearStored = async (): Promise<void> => {
      persisted = "";
      storedText = "";
      await ctx.storage.conv.remove("draft");
      await dropFromIndex();
    };

    /** Persist the composer's CURRENT text (or clear on the text→empty
     *  transition). Reads at write time, not at schedule time, so only the
     *  final state of a burst is stored. */
    const persist = async (): Promise<void> => {
      savePending = false;
      const text = ctx.composer.readDraft();
      if (!text.trim()) {
        if (hadText) {
          hadText = false;
          await clearStored(); // sent or deliberately emptied
        }
        return;
      }
      hadText = true;
      if (text === persisted) return;
      persisted = text;
      await ctx.storage.conv.set("draft", {
        text: text.slice(0, MAX_DRAFT_CHARS),
        at: new Date().toISOString(),
      });
      await touchIndexAndPrune();
    };

    const scheduleSave = (): void => {
      if (!settled) return; // restore not decided yet — never save over it
      const token = ++saveToken;
      savePending = true;
      ctx.setTimeout(() => {
        if (token !== saveToken || ctx.signal.aborted) return;
        void persist();
      }, SAVE_DEBOUNCE_MS);
    };

    // ---- restore ---------------------------------------------------------------
    void ctx.storage.conv.get("draft").then((rec) => {
      if (ctx.signal.aborted) return;
      storedText = rec.text;
      persisted = rec.text || null;
    });

    /** One attempt per tick until settled: wait for the composer AND the
     *  stored read; restore only into an EMPTY composer (never clobber text
     *  the user is actively typing). */
    const tryRestore = (): void => {
      if (settled) return;
      if (Date.now() - mountedAt > RESTORE_GIVE_UP_MS) {
        settled = true;
        return;
      }
      const composerEl = ctx.composer.find();
      if (!composerEl || storedText === null) return; // not ready yet
      const current = ctx.composer.readDraft();
      if (current.trim()) {
        // User (or claude) already has text here — theirs wins, ours stays
        // stored until their text is sent/emptied or saved over it.
        settled = true;
        hadText = true;
        return;
      }
      if (!storedText.trim()) {
        settled = true; // nothing to restore
        return;
      }
      if (ctx.composer.insertText(storedText)) {
        settled = true;
        hadText = true;
        persisted = ctx.composer.readDraft() || storedText;
      }
      // insert failed → composer mid-re-render; retry next tick until give-up
    };
    ctx.setInterval(tryRestore, RESTORE_POLL_MS);
    tryRestore();

    // ---- save triggers ---------------------------------------------------------
    // Keystrokes: document-capture input filtered to the composer (survives
    // React swapping the contenteditable node).
    ctx.listen(
      document,
      "input",
      (ev: Event) => {
        const composerEl = ctx.composer.find();
        if (!composerEl || !(ev.target instanceof Node) || !composerEl.contains(ev.target)) return;
        scheduleSave();
      },
      { capture: true, passive: true },
    );
    // Backstop: the core 600 ms draft poll — catches programmatic changes and
    // the post-send clear (no input event fires for either).
    ctx.on("composer:draft-changed", () => scheduleSave());

    // ---- flush on unmount --------------------------------------------------------
    // A save scheduled <400 ms before navigation would otherwise be lost. Only
    // flush while the page still shows THIS conversation — during SPA nav the
    // composer may already belong to the next chat, and saving that text under
    // this convId would restore the wrong draft later.
    ctx.onCleanup(() => {
      if (!savePending || !settled) return;
      saveToken++; // void the scheduled timeout's write
      if (!location.pathname.includes(convId)) return;
      void persist();
    });
  },
};
