/**
 * Live checklists — Delight & memory. Conversation scope.
 *
 * Turns Claude's step-by-step instructions into tickable checkboxes that
 * remember their state per chat. Detected step shapes, all conservative:
 * - ordered lists (`<ol>` with ≥ 2 items, not nested inside another list)
 * - markdown task lists (`<ul>` where ≥ 2 items start with "[ ]" / "[x]" —
 *   claude.ai renders `- [ ]` literally)
 * - "Step N:" paragraph sequences (≥ 2 sibling `<p>`s under one parent)
 *
 * DOM SAFETY (own-UI-only, dom-matcher hygiene):
 * - The checkbox is an ADDITIVE owned `<button>` absolutely positioned in the
 *   item's left margin (pins-style attach; claude's list DOM is never
 *   rewritten). It carries ZERO text — the ✓ and the "3/7" progress read-out
 *   are CSS pseudo-element content (`attr(data-cc-progress)`), which never
 *   enters textContent/innerText, so dom-matcher probes, folding fold-heads,
 *   selection and copy all stay byte-identical.
 * - The only touches on claude's nodes: `position: relative` when static
 *   (geometry-only, same as core/decorations) and the reversible
 *   `.cc-clk-done` dim class — both cleared on teardown.
 *
 * PERSISTENCE: ctx.storage.conv key "checklists" —
 * `<messageUuid>#<listIndex>` → checked item indices (LOCAL, per
 * conversation). A `cc:checklistIndex` meta record (convId → last-touched ms)
 * is pruned past MAX_CONVERSATIONS, mirroring draft-keeper, so abandoned
 * chats' ticks never accumulate unbounded.
 *
 * Toggle: settings.liveChecklistsOn (gear "Memory" row + palette; default
 * ON), reacted to via storage.onSettingsChanged — no feature imports.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { MetaKey } from "@/core/storage-keys";
import { ownedEl } from "@/ui/root";

const OWNER = "live-checklists";

const SWEEP_MS = 900;
/** Keep at most this many conversations' checklist state (oldest pruned). */
const MAX_CONVERSATIONS = 40;

/** A rendered markdown task-list item: "[ ] buy milk" / "[x] done". */
const TASK_RE = /^\[[ xX]\]\s/;
/** A "Step N:" / "Step 2." / "Step 3 —" paragraph opener. */
const STEP_RE = /^step\s+\d+\s*[:.\-–—]/i;

export interface DetectedList {
  /** The element the progress chip anchors to (ol/ul, or the first step p). */
  host: HTMLElement;
  /** The tickable items, in order (list-item index = position here). */
  items: HTMLElement[];
}

/** Inside companion UI or a code block — never ours to decorate. */
function offLimits(el: Element): boolean {
  return el.closest("[data-cc-owner], pre, .cc-foldhead") !== null;
}

/**
 * Collect the step-shaped lists inside one answer, in document order.
 * Exported for headless tests.
 */
export function collectChecklists(answer: HTMLElement): DetectedList[] {
  const out: DetectedList[] = [];

  // Ordered lists — top-level only (sub-lists of a step are detail, not steps).
  for (const ol of answer.querySelectorAll<HTMLOListElement>("ol")) {
    if (offLimits(ol)) continue;
    const nestedIn = ol.parentElement?.closest("li");
    if (nestedIn && answer.contains(nestedIn)) continue;
    const items = [...ol.children].filter((c): c is HTMLLIElement => c instanceof HTMLLIElement);
    if (items.length >= 2) out.push({ host: ol, items });
  }

  // Markdown task lists rendered literally: "[ ] …" items in a ul.
  for (const ul of answer.querySelectorAll<HTMLUListElement>("ul")) {
    if (offLimits(ul)) continue;
    const nestedIn = ul.parentElement?.closest("li");
    if (nestedIn && answer.contains(nestedIn)) continue;
    const direct = [...ul.children].filter((c): c is HTMLLIElement => c instanceof HTMLLIElement);
    const tasks = direct.filter((li) => TASK_RE.test((li.textContent ?? "").trimStart()));
    if (tasks.length >= 2) out.push({ host: ul, items: tasks });
  }

  // "Step N:" paragraph sequences — grouped per parent so prose between the
  // steps doesn't break the run.
  const byParent = new Map<HTMLElement, HTMLElement[]>();
  for (const p of answer.querySelectorAll<HTMLParagraphElement>("p")) {
    if (offLimits(p) || p.closest("li, blockquote")) continue;
    if (!STEP_RE.test((p.textContent ?? "").trimStart())) continue;
    const parent = p.parentElement;
    if (!parent) continue;
    const run = byParent.get(parent) ?? [];
    run.push(p);
    byParent.set(parent, run);
  }
  for (const run of byParent.values()) {
    if (run.length >= 2 && run[0]) out.push({ host: run[0], items: run });
  }

  // Stable list indices need document order.
  out.sort((a, b) =>
    a.host.compareDocumentPosition(b.host) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1,
  );
  return out;
}

export const liveChecklists: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "conversation",

  async mount(ctx: FeatureContext) {
    const convId = ctx.storage.convId;
    if (!convId) return; // no id to key checklist state under

    let on = true;
    let generating = false;
    /** `<uuid>#<listIdx>` → checked item indices (the persisted shape). */
    let state: Record<string, number[]> = {};
    let stateLoaded = false;

    // Make sure the API index (uuid source for the matcher) is being built.
    void ctx.conversation.ensure();
    void ctx.storage.conv.get("checklists").then((s) => {
      if (ctx.signal.aborted) return;
      state = s;
      stateLoaded = true;
      sweep();
    });

    const answers = (): HTMLElement[] =>
      ctx.selectors
        .queryAll<HTMLElement>("assistantMessage")
        .filter((el) => ctx.selectors.closest("messageBlock", el) !== null);

    // ---- persistence (draft-keeper's index/prune idiom) ----------------------
    const touchIndexAndPrune = async (): Promise<void> => {
      const index = await ctx.storage.getMeta<Record<string, number>>(MetaKey.checklistIndex, {});
      index[convId] = Date.now();
      const ids = Object.keys(index);
      if (ids.length > MAX_CONVERSATIONS) {
        ids.sort((a, b) => (index[a] ?? 0) - (index[b] ?? 0));
        for (const old of ids.slice(0, ids.length - MAX_CONVERSATIONS)) {
          if (old === convId) continue;
          await ctx.storage.removeConv(old, "checklists");
          delete index[old];
        }
      }
      await ctx.storage.setMeta(MetaKey.checklistIndex, index);
    };

    const persist = (): void => {
      void ctx.storage.conv.set("checklists", state).then(() => touchIndexAndPrune());
    };

    // ---- equip (pins-style additive attach + maintenance sweep) --------------
    const equip = (answer: HTMLElement): void => {
      const uuid = answer.dataset["ccUuid"] ?? ctx.matcher.uuidForElement(answer);
      if (!uuid) return; // streaming / index not ready — quiet skip

      collectChecklists(answer).forEach((list, listIdx) => {
        const key = `${uuid}#${listIdx}`;
        const done = new Set(state[key] ?? []);

        list.items.forEach((item, i) => {
          if (!item.dataset["ccClkPos"]) {
            if (getComputedStyle(item).position === "static") {
              item.style.position = "relative"; // geometry-only (decorations idiom)
            }
            item.dataset["ccClkPos"] = "1"; // computed-style once per rendered node
          }
          let box = item.querySelector<HTMLButtonElement>(":scope > .cc-clk-box");
          if (!box) {
            box = ownedEl("button", {
              owner: OWNER,
              className: "cc-clk-box",
              attrs: { type: "button" },
            });
            item.prepend(box); // additive; zero text, absolutely positioned
          }
          const isDone = done.has(i);
          box.dataset["ccKey"] = key;
          box.dataset["ccItem"] = String(i);
          box.classList.toggle("cc-clk-on", isDone);
          box.setAttribute("aria-pressed", isDone ? "true" : "false");
          const label = `${isDone ? "Un-tick" : "Tick"} step ${i + 1} of ${list.items.length}`;
          box.title = label;
          box.setAttribute("aria-label", label);
          item.classList.toggle("cc-clk-done", isDone);
        });

        // Progress chip — text lives in a data attribute rendered by CSS
        // ::after (never part of innerText; dom-matcher hygiene).
        if (!list.host.dataset["ccClkPos"]) {
          if (getComputedStyle(list.host).position === "static") {
            list.host.style.position = "relative";
          }
          list.host.dataset["ccClkPos"] = "1";
        }
        let chip = list.host.querySelector<HTMLElement>(":scope > .cc-clk-progress");
        if (!chip) {
          chip = ownedEl("span", {
            owner: OWNER,
            className: "cc-clk-progress",
            attrs: { "aria-hidden": "true" },
          });
          list.host.append(chip);
        }
        const nDone = list.items.reduce((n, _item, i) => n + (done.has(i) ? 1 : 0), 0);
        chip.dataset["ccProgress"] = `${nDone}/${list.items.length}`;
        chip.classList.toggle("cc-clk-complete", nDone === list.items.length);
      });
    };

    const removeAll = (): void => {
      for (const el of document.querySelectorAll(
        `.cc-clk-box[data-cc-owner="${OWNER}"], .cc-clk-progress[data-cc-owner="${OWNER}"]`,
      )) {
        el.remove();
      }
      for (const el of document.querySelectorAll(".cc-clk-done")) {
        el.classList.remove("cc-clk-done");
      }
    };

    // ---- toggle (delegated — survives virtualization re-renders) -------------
    ctx.listen(document, "click", (ev: MouseEvent) => {
      const target = ev.target instanceof Element ? ev.target : null;
      const box = target?.closest<HTMLButtonElement>(".cc-clk-box");
      if (!box || box.dataset["ccOwner"] !== OWNER) return;
      ev.preventDefault();
      ev.stopPropagation();
      const key = box.dataset["ccKey"];
      const idx = Number(box.dataset["ccItem"]);
      if (!key || !Number.isInteger(idx)) return;
      const done = new Set(state[key] ?? []);
      if (done.has(idx)) done.delete(idx);
      else done.add(idx);
      if (done.size === 0) delete state[key];
      else state[key] = [...done].sort((a, b) => a - b);
      persist();
      // Re-sync classes + progress on the owning answer immediately.
      const answer = ctx.selectors.closest<HTMLElement>("assistantMessage", box);
      if (answer) equip(answer);
    });

    // ---- the one reconcile path ----------------------------------------------
    const sweep = (): void => {
      // While streaming, list items churn every tick — the post-generation
      // conversation:updated re-runs us over the settled text.
      if (!on || !stateLoaded || generating) return;
      for (const el of answers()) equip(el);
    };

    ctx.on("generation:start", () => {
      generating = true;
    });
    ctx.on("generation:end", () => {
      generating = false;
    });

    // ---- settings toggle (gear "Memory" row / palette — no feature imports) --
    const settings = await ctx.storage.getSettings();
    if (ctx.signal.aborted) return;
    on = settings.liveChecklistsOn;
    // The state read above may have swept before the setting landed — undo.
    if (!on) removeAll();

    ctx.onCleanup(
      ctx.storage.onSettingsChanged((s) => {
        if (s.liveChecklistsOn === on) return;
        on = s.liveChecklistsOn;
        if (on) sweep();
        else removeAll();
      }),
    );

    ctx.setInterval(sweep, SWEEP_MS);
    ctx.on("conversation:updated", sweep);
    sweep();

    // Runtime disposal sweeps [data-cc-owner] nodes; the dim class needs the
    // explicit pass (it lives on claude's own li/p elements).
    ctx.onCleanup(removeAll);
  },
};
