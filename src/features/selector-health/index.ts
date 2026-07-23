/**
 * Selector Health — session scope. The self-healing layer's visible surface
 * (Phase 2 of the scope doc): a dashboard of every anchor the extension has
 * into claude.ai (DOM selectors + API endpoints) with live health from the
 * override layer's ledger, a break-alert banner, and the merged override
 * editor (shipped defaults locked/dimmed, user overrides layered on top,
 * per-entry reset, export/import).
 *
 * Data flow: `ctx.selectors.health()` + `ctx.overrides` (the OverrideStore's
 * feature slice) are the ONLY sources — every write goes through the store's
 * validated, origin-pinned write path; this panel cannot bypass it. The
 * "used by" column comes from the compile-time-exhaustive static map in
 * `deps.ts` (see its header for how it is kept in sync).
 *
 * Entry points (features never import each other): bus
 * `ui:selector-health-toggle`, emitted by the gear menu's Self-healing row
 * and the command palette ("Selector health").
 *
 * Repair (Phase 3, repair.ts): broken/fallback SELECTOR rows route their
 * Repair button to the Claude-assisted flow — sanitized structure-only DOM
 * sketch → session (clipboard + paste-back, default) or opt-in API key →
 * validate → live probe + decorations flash → red→green diff → user-applied
 * via ctx.overrides.set(source:"repair"). Never auto-applied. ENDPOINT rows
 * keep routing to the manual editor (path templates are typed, not
 * sketched); "edit" always means the manual editor.
 *
 * Standards: own-UI-only under #cc-root, ctx-managed resources with full
 * teardown, ONE delegated click listener for all rebuilt rows (renders are
 * listener-free, so the periodic refresh never grows the resource ledger),
 * colors via companion.css var(--cc-*) tokens only, z from the Z.chip band
 * (closes when the palette opens — same yield as the atlas), reduced-motion
 * respected (CSS-gated animation, instant scrolls).
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import type {
  EndpointOverride,
  SelectorHealth,
  SelectorOverride,
  SetResult,
} from "@/core/overrides";
import { endpointDefaultTemplate } from "@/core/overrides";
import { SELECTORS, type SelectorEntry, type SelectorName } from "@/core/selectors";
import { API_VERSION, ENDPOINT_PARAMS, type EndpointName } from "@/api/endpoints";
import { ownedEl } from "@/ui/root";
import { relativeTime } from "@/shared/time";
import { SELECTOR_DEPS, ENDPOINT_DEPS, depsSummary } from "./deps";
import { buildAlert, buildHealthPanel } from "./panel";
import { createRepairController } from "./repair";

const OWNER = "selector-health";

/** Dashboard/alert refresh cadence while relevant (health is per-query). */
const REFRESH_MS = 1500;
/** How many affected features the alert names before eliding. */
const ALERT_FEATURES_MAX = 4;

const UNKNOWN_HEALTH: SelectorHealth = {
  state: "unknown",
  lastMatchedVariant: null,
  lastMatchedAt: null,
  matchCount: 0,
  missStreak: 0,
  lastMatchPath: null,
};

interface RowBase {
  kind: "selector" | "endpoint";
  desc: string;
  deps: readonly string[];
  health: SelectorHealth;
  stale: boolean;
}
type Row =
  | (RowBase & { ns: "selectors"; name: SelectorName; override: SelectorOverride | undefined })
  | (RowBase & { ns: "endpoints"; name: EndpointName; override: EndpointOverride | undefined });

type EditTarget =
  | { ns: "selectors"; name: SelectorName }
  | { ns: "endpoints"; name: EndpointName };

const SELECTOR_NAMES = Object.keys(SELECTORS) as readonly SelectorName[];
const ENDPOINT_NAMES = Object.keys(ENDPOINT_PARAMS) as readonly EndpointName[];

function entryKey(t: { ns: string; name: string }): string {
  return `${t.ns}:${t.name}`;
}

/** Re-establish the ns↔name correlation TS loses on property reads. */
function toTarget(row: Row): EditTarget {
  return row.ns === "selectors"
    ? { ns: "selectors", name: row.name }
    : { ns: "endpoints", name: row.name };
}

/** Inverse of {@link entryKey}, validated against the anchor allowlists. */
function parseTarget(key: string | undefined): EditTarget | null {
  if (!key) return null;
  const idx = key.indexOf(":");
  if (idx < 0) return null;
  const ns = key.slice(0, idx);
  const name = key.slice(idx + 1);
  if (ns === "selectors" && (SELECTOR_NAMES as readonly string[]).includes(name)) {
    return { ns: "selectors", name: name as SelectorName };
  }
  if (ns === "endpoints" && (ENDPOINT_NAMES as readonly string[]).includes(name)) {
    return { ns: "endpoints", name: name as EndpointName };
  }
  return null;
}

/** Health lastMatchedAt (epoch ms) → the shared relative formatter. */
function relTime(ms: number): string {
  return relativeTime(new Date(ms).toISOString());
}

/** "yours" for hand edits, provenance verbatim otherwise. */
function sourceTag(source: SelectorOverride["source"]): string {
  return source === "user" ? "yours" : source;
}

export const selectorHealth: FeatureModule = {
  id: OWNER,
  tier: 3,
  scope: "session",

  mount(ctx: FeatureContext) {
    const refs = buildHealthPanel(OWNER);
    const alertRefs = buildAlert(OWNER);
    ctx.root.append(refs.scrim, refs.panel, alertRefs.alert);
    ctx.onCleanup(() => {
      refs.scrim.remove();
      refs.panel.remove();
      alertRefs.alert.remove();
    });

    // "Repair with Claude" (Phase 3) — mounts its card into the repair host;
    // its own cleanup (flash + card removal) rides the same ctx ledger.
    const repair = createRepairController({
      ctx,
      owner: OWNER,
      host: refs.repairHost,
      onApplied: () => refreshPanel(),
    });

    refs.headSub.textContent =
      `core v${ctx.overrides.exportFile().coreVersion} · anchors verified ${API_VERSION}`;

    // ---- state -------------------------------------------------------------
    let isOpen = false;
    let editing: EditTarget | null = null;
    /** Break-alert bookkeeping: which anchors we already alerted about this
     *  session, and whether the user hit "Later" (a NEW broken anchor
     *  re-arms the banner). */
    const alertedKeys = new Set<string>();
    let alertDismissed = false;

    // ---- data --------------------------------------------------------------
    const collectRows = (): Row[] => {
      const rows: Row[] = [];
      const overrides = ctx.overrides.list();
      const selHealth = ctx.selectors.health();
      for (const name of SELECTOR_NAMES) {
        rows.push({
          ns: "selectors",
          name,
          kind: "selector",
          desc: SELECTORS[name].description,
          deps: SELECTOR_DEPS[name],
          health: selHealth.get(name) ?? UNKNOWN_HEALTH,
          override: overrides.selectors.get(name),
          stale: ctx.overrides.isStale("selectors", name),
        });
      }
      const epHealth = ctx.overrides.endpointHealth();
      for (const name of ENDPOINT_NAMES) {
        rows.push({
          ns: "endpoints",
          name,
          kind: "endpoint",
          desc: endpointDefaultTemplate(name),
          deps: ENDPOINT_DEPS[name],
          health: epHealth.get(name) ?? UNKNOWN_HEALTH,
          override: overrides.endpoints.get(name),
          stale: ctx.overrides.isStale("endpoints", name),
        });
      }
      return rows;
    };

    const brokenRows = (): Row[] => collectRows().filter((r) => r.health.state === "broken");

    const affectedFeatures = (rows: readonly Row[]): string => {
      const feats: string[] = [];
      for (const row of rows) {
        for (const d of row.deps) if (!feats.includes(d)) feats.push(d);
      }
      if (feats.length === 0) return "no mapped features";
      const head = feats.slice(0, ALERT_FEATURES_MAX).join(", ");
      return feats.length > ALERT_FEATURES_MAX ? `${head}, …` : head;
    };

    // ---- dashboard table (render-only — clicks ride the delegated handler) --
    const badge = (health: SelectorHealth): HTMLSpanElement => {
      const map = {
        healthy: { cls: "cc-sh-ok", text: "✓ healthy" },
        override: { cls: "cc-sh-ok", text: "✓ healthy" },
        fallback: { cls: "cc-sh-amber", text: "⚠ using fallback" },
        broken: { cls: "cc-sh-danger", text: "✗ broken" },
        unknown: { cls: "cc-sh-dim", text: "— not queried" },
      } as const;
      const v = map[health.state];
      return ownedEl("span", { owner: OWNER, className: `cc-sh-badge ${v.cls}`, text: v.text });
    };

    const renderTable = (): void => {
      const rows = collectRows();
      refs.tableBody.replaceChildren();
      for (const row of rows) {
        const tr = ownedEl("tr", { owner: OWNER });
        tr.dataset["ccAnchor"] = entryKey(row);
        if (row.health.state === "broken") tr.classList.add("cc-sh-broken-row");

        const anchorTd = ownedEl("td", { owner: OWNER });
        const nameLine = ownedEl("div", { owner: OWNER, className: "cc-sh-anchor" });
        nameLine.append(
          ownedEl("span", { owner: OWNER, text: row.name }),
          ownedEl("span", { owner: OWNER, className: "cc-sh-kind", text: row.kind }),
        );
        anchorTd.append(
          nameLine,
          ownedEl("div", { owner: OWNER, className: "cc-sh-anchor-desc", text: row.desc }),
        );

        const statusTd = ownedEl("td", { owner: OWNER });
        statusTd.append(badge(row.health));
        if (row.override) {
          statusTd.append(
            ownedEl("span", { owner: OWNER, className: "cc-sh-tag", text: "override" }),
          );
        }
        if (row.stale) {
          statusTd.append(ownedEl("span", { owner: OWNER, className: "cc-sh-tag", text: "stale" }));
        }

        const depsTd = ownedEl("td", {
          owner: OWNER,
          className: "cc-sh-deps",
          text: depsSummary(row.deps),
        });
        if (row.deps.length > 0) depsTd.title = row.deps.join(", ");

        const metaTd = ownedEl("td", {
          owner: OWNER,
          className: "cc-sh-meta",
          text:
            row.health.lastMatchedAt === null
              ? "never"
              : `${relTime(row.health.lastMatchedAt)} · ${row.health.matchCount}×`,
        });

        const actTd = ownedEl("td", { owner: OWNER, className: "cc-sh-act" });
        if (row.health.state === "broken" || row.health.state === "fallback") {
          actTd.append(
            ownedEl("button", {
              owner: OWNER,
              className: row.health.state === "broken" ? "cc-sh-btn-accent" : "cc-btn",
              text: "Repair",
              attrs: {
                type: "button",
                title:
                  row.ns === "selectors"
                    ? `Repair ${row.name} with Claude`
                    : `Fix the ${row.name} path template by hand`,
                "data-cc-act": "repair",
              },
            }),
          );
        }

        tr.append(anchorTd, statusTd, depsTd, metaTd, actTd);
        refs.tableBody.append(tr);
      }
    };

    // ---- banner strip (inside the panel) ------------------------------------
    const renderBanner = (): void => {
      refs.bannerHost.replaceChildren();
      const rows = collectRows();
      const broken = rows.filter((r) => r.health.state === "broken");
      const fallback = rows.filter((r) => r.health.state === "fallback");
      const overridden = rows.filter((r) => r.override !== undefined);

      if (broken.length > 0) {
        const first = broken[0];
        const el = ownedEl("div", { owner: OWNER, className: "cc-sh-banner cc-sh-banner-bad" });
        const msg = ownedEl("span", { owner: OWNER, className: "cc-sh-alert-msg" });
        const b = ownedEl("b", { owner: OWNER });
        b.textContent = `${broken.length} anchor${broken.length === 1 ? "" : "s"} broke`;
        msg.append(
          b,
          ` — ${broken.map((r) => r.name).join(", ")} · affects ${affectedFeatures(broken)}.`,
        );
        el.append(
          ownedEl("span", {
            owner: OWNER,
            className: "cc-sh-alert-sig",
            text: "⚠",
            attrs: { "aria-hidden": "true" },
          }),
          msg,
          ownedEl("button", {
            owner: OWNER,
            className: "cc-sh-btn-accent",
            text: "Repair…",
            attrs: {
              type: "button",
              "data-cc-act": "repair",
              ...(first ? { "data-cc-anchor": entryKey(first) } : {}),
            },
          }),
        );
        refs.bannerHost.append(el);
        return;
      }

      if (overridden.length > 0 || fallback.length > 0) {
        const el = ownedEl("div", { owner: OWNER, className: "cc-sh-banner cc-sh-banner-ok" });
        const bits: string[] = [];
        if (overridden.length > 0) {
          bits.push(`${overridden.length} healed via local overrides — no update, no reinstall`);
        }
        if (fallback.length > 0) {
          bits.push(`${fallback.length} on a shipped fallback (primary died — borrowed time)`);
        }
        el.append(
          ownedEl("span", { owner: OWNER, text: "✓", attrs: { "aria-hidden": "true" } }),
          ownedEl("span", {
            owner: OWNER,
            className: "cc-sh-alert-msg",
            text: `No broken anchors. ${bits.join(" · ")}.`,
          }),
        );
        refs.bannerHost.append(el);
      }
    };

    // ---- override editor (render-only) --------------------------------------
    const valueText = (row: Row): { def: string; ov: string | null } => {
      if (row.ns === "selectors") {
        const entry: SelectorEntry = SELECTORS[row.name];
        const fbs = entry.fallbacks?.length ?? 0;
        const ovFbs = row.override?.fallbacks?.length ?? 0;
        return {
          def: entry.primary + (fbs > 0 ? `  +${fbs} fallback${fbs === 1 ? "" : "s"}` : ""),
          ov: row.override
            ? row.override.primary +
              (ovFbs > 0 ? `  +${ovFbs} fallback${ovFbs === 1 ? "" : "s"}` : "")
            : null,
        };
      }
      return { def: endpointDefaultTemplate(row.name), ov: row.override?.pathTemplate ?? null };
    };

    const buildEditForm = (row: Row): HTMLDivElement => {
      const form = ownedEl("div", { owner: OWNER, className: "cc-sh-form" });

      const field = (labelText: string, control: HTMLElement): HTMLLabelElement => {
        const label = ownedEl("label", { owner: OWNER, className: "cc-sh-field" });
        label.append(
          ownedEl("span", { owner: OWNER, className: "cc-sh-field-k", text: labelText }),
          control,
        );
        return label;
      };

      const noteInput = ownedEl("input", {
        owner: OWNER,
        className: "cc-input cc-sh-in",
        attrs: {
          type: "text",
          placeholder: "optional — why this override exists",
          spellcheck: "false",
          "data-cc-in": "note",
        },
      });
      noteInput.value = row.override?.note ?? "";

      if (row.ns === "selectors") {
        const primaryInput = ownedEl("input", {
          owner: OWNER,
          className: "cc-input cc-sh-in cc-sh-mono",
          attrs: { type: "text", spellcheck: "false", "data-cc-in": "primary" },
        });
        primaryInput.value = row.override?.primary ?? SELECTORS[row.name].primary;
        const fbArea = ownedEl("textarea", {
          owner: OWNER,
          className: "cc-input cc-sh-in cc-sh-mono cc-sh-ta",
          attrs: {
            rows: "2",
            placeholder: "one selector per line (optional)",
            spellcheck: "false",
            "data-cc-in": "fallbacks",
          },
        });
        fbArea.value = (row.override?.fallbacks ?? []).join("\n");
        form.append(
          field("primary selector", primaryInput),
          field("fallbacks", fbArea),
          field("note", noteInput),
        );
      } else {
        const tplInput = ownedEl("input", {
          owner: OWNER,
          className: "cc-input cc-sh-in cc-sh-mono",
          attrs: { type: "text", spellcheck: "false", placeholder: "/api/…", "data-cc-in": "template" },
        });
        tplInput.value = row.override?.pathTemplate ?? endpointDefaultTemplate(row.name);
        const params = ENDPOINT_PARAMS[row.name];
        const hint = ownedEl("div", {
          owner: OWNER,
          className: "cc-sh-hint",
          text:
            params.length > 0
              ? `origin-pinned: relative /api/… path · placeholders: ${params.map((p) => `{${p}}`).join(" ")}`
              : "origin-pinned: relative /api/… path · no placeholders",
        });
        form.append(field("path template", tplInput), hint, field("note", noteInput));
      }

      const err = ownedEl("div", { owner: OWNER, className: "cc-sh-err cc-hidden" });
      const actions = ownedEl("div", { owner: OWNER, className: "cc-sh-form-actions" });
      actions.append(
        ownedEl("button", {
          owner: OWNER,
          className: "cc-sh-btn-accent",
          text: "Save override",
          attrs: { type: "button", "data-cc-act": "save" },
        }),
        ownedEl("button", {
          owner: OWNER,
          className: "cc-btn",
          text: "Cancel",
          attrs: { type: "button", "data-cc-act": "cancel" },
        }),
        ownedEl("span", {
          owner: OWNER,
          className: "cc-sh-meta",
          text: "applies instantly · no reload",
        }),
      );
      form.append(err, actions);
      return form;
    };

    const buildEntry = (row: Row): HTMLDivElement => {
      const isEditing = editing !== null && editing.ns === row.ns && editing.name === row.name;
      const entry = ownedEl("div", { owner: OWNER, className: "cc-sh-entry" });
      entry.dataset["ccAnchor"] = entryKey(row);
      const { def, ov } = valueText(row);

      // Shipped default — locked, dimmed; struck through when shadowed.
      const defRow = ownedEl("div", {
        owner: OWNER,
        className: "cc-sh-row cc-sh-locked" + (row.override ? " cc-sh-shadowed" : ""),
      });
      defRow.append(
        ownedEl("span", {
          owner: OWNER,
          className: "cc-sh-lock",
          text: "🔒",
          attrs: { "aria-hidden": "true" },
        }),
        ownedEl("span", { owner: OWNER, className: "cc-sh-nm", text: row.name }),
        ownedEl("span", { owner: OWNER, className: "cc-sh-vl", text: def }),
      );
      if (!row.override && !isEditing) {
        defRow.append(
          ownedEl("button", {
            owner: OWNER,
            className: "cc-sh-mini",
            text: "override",
            attrs: {
              type: "button",
              title: `Write a local override for ${row.name}`,
              "data-cc-act": "edit",
            },
          }),
        );
      }
      entry.append(defRow);

      // User override — editable layer on top.
      if (row.override && ov !== null) {
        const ovRow = ownedEl("div", { owner: OWNER, className: "cc-sh-row cc-sh-ov" });
        ovRow.append(
          ownedEl("span", {
            owner: OWNER,
            className: "cc-sh-src",
            text: sourceTag(row.override.source),
          }),
          ownedEl("span", { owner: OWNER, className: "cc-sh-nm", text: row.name }),
          ownedEl("span", {
            owner: OWNER,
            className: "cc-sh-vl",
            text: ov,
            attrs: row.override.note ? { title: row.override.note } : {},
          }),
        );
        if (row.stale) {
          ovRow.append(
            ownedEl("span", {
              owner: OWNER,
              className: "cc-sh-tag",
              text: "stale",
              attrs: {
                title:
                  "The core now ships its own fix for this anchor — keep your override or reset to default",
              },
            }),
          );
        }
        ovRow.append(
          ownedEl("button", {
            owner: OWNER,
            className: "cc-sh-mini",
            text: "edit",
            attrs: { type: "button", "data-cc-act": "edit" },
          }),
          ownedEl("button", {
            owner: OWNER,
            className: "cc-sh-mini cc-sh-reset",
            text: "reset to default",
            attrs: {
              type: "button",
              title: "Delete this override — the shipped default is intact underneath",
              "data-cc-act": "reset",
            },
          }),
        );
        entry.append(ovRow);
      }

      if (isEditing) entry.append(buildEditForm(row));
      return entry;
    };

    const renderEditor = (): void => {
      refs.edHost.replaceChildren();
      const rows = collectRows();
      refs.edHost.append(ownedEl("div", { owner: OWNER, className: "cc-sh-grp", text: "selectors" }));
      for (const row of rows) if (row.ns === "selectors") refs.edHost.append(buildEntry(row));
      refs.edHost.append(
        ownedEl("div", {
          owner: OWNER,
          className: "cc-sh-grp",
          text: "endpoints · origin-pinned: /api/… paths only",
        }),
      );
      for (const row of rows) if (row.ns === "endpoints") refs.edHost.append(buildEntry(row));
    };

    const refreshPanel = (): void => {
      renderBanner();
      renderTable();
      renderEditor();
    };

    // ---- open / close ------------------------------------------------------
    const close = (): void => {
      if (!isOpen) return;
      isOpen = false;
      editing = null;
      repair.close();
      refs.scrim.classList.add("cc-hidden");
      refs.panel.classList.add("cc-hidden");
    };

    const openPanel = (): void => {
      if (isOpen) return;
      isOpen = true;
      hideAlert();
      refs.scrim.classList.remove("cc-hidden");
      refs.panel.classList.remove("cc-hidden");
      refreshPanel();
    };

    /** Open (if needed) and jump to one anchor's editor entry with its edit
     *  form expanded — the MANUAL fix path (endpoints, and the editor's own
     *  "edit" affordance). */
    const openEditorAt = (target: EditTarget): void => {
      editing = target;
      repair.close();
      if (!isOpen) {
        isOpen = true;
        hideAlert();
        refs.scrim.classList.remove("cc-hidden");
        refs.panel.classList.remove("cc-hidden");
      }
      refreshPanel();
      const el = refs.edHost.querySelector(`[data-cc-anchor="${entryKey(target)}"]`);
      // Instant jump — no smooth scroll to gate on reduced-motion.
      if (el instanceof HTMLElement) el.scrollIntoView({ block: "center" });
      const input = el?.querySelector("input");
      if (input instanceof HTMLInputElement) input.focus();
    };

    /** Open (if needed) the Claude-assisted repair card for one SELECTOR
     *  anchor — the Phase-3 flow behind every selector Repair button. */
    const openRepairAt = (name: SelectorName): void => {
      editing = null;
      if (!isOpen) {
        isOpen = true;
        refs.scrim.classList.remove("cc-hidden");
        refs.panel.classList.remove("cc-hidden");
      }
      hideAlert();
      refreshPanel();
      repair.open(name);
      // Instant jump — no smooth scroll to gate on reduced-motion.
      repair.element.scrollIntoView({ block: "nearest" });
    };

    ctx.on("ui:selector-health-toggle", () => {
      if (isOpen) close();
      else openPanel();
    });
    // The palette shares the z-44 band — yield the stage when it opens (same
    // contract as the atlas overlay).
    ctx.on("ui:palette-toggle", () => close());
    ctx.listen(refs.closeBtn, "click", () => close());
    ctx.listen(refs.scrim, "mousedown", () => close());
    ctx.listen(
      window,
      "keydown",
      (e: KeyboardEvent) => {
        if (!isOpen || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (repair.isOpen) {
          repair.close();
        } else if (editing) {
          editing = null;
          renderEditor();
        } else {
          close();
        }
      },
      { capture: true },
    );
    ctx.onCleanup(() => close());

    // ---- delegated actions (rows/forms rebuild constantly; ONE listener) ----
    const saveFromForm = async (form: HTMLElement, target: EditTarget): Promise<void> => {
      const val = (k: string): string =>
        form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-cc-in="${k}"]`)?.value ??
        "";
      const note = val("note").trim();
      let res: SetResult;
      if (target.ns === "selectors") {
        const fallbacks = val("fallbacks")
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        res = await ctx.overrides.set("selectors", target.name, {
          primary: val("primary").trim(),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
          source: "user",
          ...(note ? { note } : {}),
        });
      } else {
        res = await ctx.overrides.set("endpoints", target.name, {
          pathTemplate: val("template").trim(),
          source: "user",
          ...(note ? { note } : {}),
        });
      }
      if (ctx.signal.aborted) return;
      if (!res.ok) {
        const err = form.querySelector<HTMLElement>(".cc-sh-err");
        if (err) {
          err.textContent = res.reason;
          err.classList.remove("cc-hidden");
        }
        return;
      }
      editing = null;
      refreshPanel();
    };

    ctx.listen(refs.panel, "click", (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const btn = t?.closest<HTMLElement>("[data-cc-act]");
      if (!btn || !refs.panel.contains(btn)) return;
      const act = btn.dataset["ccAct"];
      if (act === "cancel") {
        editing = null;
        renderEditor();
        return;
      }
      const target = parseTarget(
        btn.dataset["ccAnchor"] ?? btn.closest<HTMLElement>("[data-cc-anchor]")?.dataset["ccAnchor"],
      );
      if (!target) return;
      if (act === "repair") {
        // Selectors get the Claude-assisted flow; endpoint repair stays a
        // manual path-template edit (typed, not AI-sketched).
        if (target.ns === "selectors") openRepairAt(target.name);
        else openEditorAt(target);
      } else if (act === "edit") {
        openEditorAt(target);
      } else if (act === "reset") {
        const done =
          target.ns === "selectors"
            ? ctx.overrides.reset("selectors", target.name)
            : ctx.overrides.reset("endpoints", target.name);
        void done.then(() => {
          if (ctx.signal.aborted) return;
          if (editing && entryKey(editing) === entryKey(target)) editing = null;
          refreshPanel();
        });
      } else if (act === "save") {
        const form = btn.closest<HTMLElement>(".cc-sh-form");
        if (form) void saveFromForm(form, target);
      }
    });

    // ---- break-alert banner (outside the panel) ----------------------------
    const hideAlert = (): void => alertRefs.alert.classList.add("cc-hidden");

    const considerAlert = (): void => {
      const broken = brokenRows();
      if (broken.length === 0 || isOpen) {
        hideAlert();
        return;
      }
      const fresh = broken.filter((r) => !alertedKeys.has(entryKey(r)));
      for (const r of broken) alertedKeys.add(entryKey(r));
      // "Later" holds until a NEW anchor breaks.
      if (fresh.length > 0) alertDismissed = false;
      if (alertDismissed) return;
      alertRefs.msg.replaceChildren();
      const b = ownedEl("b", { owner: OWNER });
      b.textContent = `${broken.length} anchor${broken.length === 1 ? "" : "s"} broke`;
      alertRefs.msg.append(b, ` after a claude.ai update — ${affectedFeatures(broken)} affected.`);
      alertRefs.alert.classList.remove("cc-hidden");
    };

    ctx.listen(alertRefs.repairBtn, "click", () => {
      hideAlert();
      const first = brokenRows()[0];
      if (!first) {
        openPanel();
      } else if (first.ns === "selectors") {
        openRepairAt(first.name);
      } else {
        openEditorAt(toTarget(first));
      }
    });
    ctx.listen(alertRefs.laterBtn, "click", () => {
      alertDismissed = true;
      hideAlert();
    });

    ctx.on("selector:degraded", ({ state }) => {
      if (state === "broken") considerAlert();
      if (isOpen) {
        renderBanner();
        renderTable();
      }
    });
    // Endpoint breakage has no dedicated transition event — api:degraded fires
    // on every http/schema failure; the broken/transient distinction lives in
    // the endpoint health ledger we read from.
    ctx.on("api:degraded", () => {
      considerAlert();
      if (isOpen) {
        renderBanner();
        renderTable();
      }
    });

    // ---- live refresh ------------------------------------------------------
    // The health ledger mutates on every query with no per-match event (by
    // design — match noise would flood the bus); poll it cheaply instead.
    ctx.setInterval(() => {
      if (isOpen) {
        renderBanner();
        renderTable();
      } else if (!alertRefs.alert.classList.contains("cc-hidden") && brokenRows().length === 0) {
        hideAlert(); // recovered while the banner was up
      }
    }, REFRESH_MS);

    // Override changes (own writes or another context's) → re-render.
    ctx.onCleanup(
      ctx.overrides.onChanged(() => {
        if (isOpen) refreshPanel();
      }),
    );

    // ---- export / import ---------------------------------------------------
    const showEdStatus = (text: string, bad: boolean): void => {
      refs.edStatus.textContent = text;
      refs.edStatus.classList.toggle("cc-sh-ed-status-bad", bad);
      refs.edStatus.classList.remove("cc-hidden");
    };

    ctx.listen(refs.exportBtn, "click", () => {
      const file = ctx.overrides.exportFile();
      const n =
        Object.keys(file.selectors.entries).length + Object.keys(file.endpoints.entries).length;
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = ownedEl("a", { owner: OWNER });
      a.href = url;
      a.download = `clenby-overrides-${file.exportedAt.slice(0, 10)}.json`;
      a.click();
      ctx.setTimeout(() => URL.revokeObjectURL(url), 5000);
      showEdStatus(`exported ${n} override${n === 1 ? "" : "s"}`, false);
    });

    ctx.listen(refs.importBtn, "click", () => refs.fileInput.click());
    ctx.listen(refs.fileInput, "change", () => {
      const file = refs.fileInput.files?.[0];
      refs.fileInput.value = ""; // allow re-picking the same file
      if (!file) return;
      void file
        .text()
        .then(async (text) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            showEdStatus("import failed: not valid JSON", true);
            return;
          }
          const res = await ctx.overrides.importFile(parsed);
          if (ctx.signal.aborted) return;
          if (!res.ok) {
            showEdStatus(`import failed: ${res.reason}`, true);
            return;
          }
          showEdStatus(
            `imported ${res.selectors} selector + ${res.endpoints} endpoint override${
              res.selectors + res.endpoints === 1 ? "" : "s"
            }${res.dropped > 0 ? ` · ${res.dropped} dropped by validation` : ""}`,
            false,
          );
          refreshPanel();
        })
        .catch(() => showEdStatus("import failed: could not read the file", true));
    });
  },
};
