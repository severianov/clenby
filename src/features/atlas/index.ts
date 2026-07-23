/**
 * Conversation Atlas — Tier 2, conversation scope.
 *
 * A full-viewport radial map of the open conversation: a small anchor node
 * (the conversation itself) sits at the center, the user's questions ring it
 * as glowing hubs on dashed spokes (Q1 at twelve o'clock, clockwise =
 * chronological), and Claude's answer-section headings fan outward from each
 * hub as topic-colored satellites. Pan (drag), cursor-anchored wheel zoom
 * (0.4×–2.5×), hover tooltip + edge highlight, click → detail panel with
 * "Jump to message →" (the real ctx.matcher seek, exactly like the outline).
 *
 * Same data as the outline: the API conversation index (ctx.conversation) +
 * the shared heading/label helpers (@/shared/message-outline). The graph is
 * computed fresh from the real messages at every open — nothing hardcoded.
 *
 * Entry points (features never import each other): bus `ui:atlas-toggle`,
 * emitted by the command palette ("Conversation Atlas") and the gear menu's
 * Reading row. Outside a conversation the feature isn't mounted, so the
 * toggle is a quiet no-op.
 *
 * Standards: own-UI-only (everything under #cc-root; claude's DOM untouched),
 * managed ctx resources only, colors exclusively via companion.css tokens
 * (topic hues are `data-cc-topic` → var(--cc-*) mappings), reduced-motion
 * respected (CSS gates + instant reset-view), Esc deselects then closes.
 */

import type { FeatureContext, FeatureModule } from "@/core/feature";
import { ownedEl, setGeometry } from "@/ui/root";
import { prefersReducedMotion } from "@/ui/motion";
import { clip } from "@/shared/text";
import { buildAtlasData } from "./data";
import { CENTER_R, CHILD_R, HUB_R, computeLayout, curvePath, type PlacedHub } from "./layout";
import { TOPIC_DEFS, topicLabel, type TopicId } from "./topics";
import { buildAtlasOverlay, svgEl, type AtlasRefs } from "./panel";

const OWNER = "atlas";

const ZOOM_MAX = 2.5;
const ZOOM_MIN_FLOOR = 0.4;
const FIT_PADDING = 0.92;
const HOME_ANIM_MS = 450;
const WHEEL_ZOOM_K = 0.0012;
const CLICK_SLOP_PX = 5;
const GRID_STEP_PX = 26;
const PULSE_MS = 850;
const CLOSE_AFTER_JUMP_MS = 240;
/** Entrance stagger (inline animation-delay — timing-only, like highlights). */
const HUB_STAGGER_S = 0.13;
const CHILD_STAGGER_S = 0.06;

interface NodeRec {
  id: string;
  kind: "hub" | "child";
  topic: TopicId;
  title: string;
  snippet: string;
  x: number;
  y: number;
  r: number;
  el: SVGGElement;
  scaler: SVGGElement;
  /** Jump target: the owning message uuid (+ heading for satellites). */
  uuid: string;
  headingText: string | null;
  /** Hub: own Q number. Child: the parent hub's Q number. */
  qIndex: number;
  /** Hub-only: satellite count (detail panel). */
  childCount: number;
  /** Child-only: 1-based assistant-reply ordinal. */
  answerNo: number;
}

export const atlas: FeatureModule = {
  id: OWNER,
  tier: 2,
  scope: "conversation",

  mount(ctx: FeatureContext) {
    const refs: AtlasRefs = buildAtlasOverlay(OWNER);
    ctx.root.appendChild(refs.overlay);
    ctx.onCleanup(() => refs.overlay.remove());

    // ---- state -----------------------------------------------------------------
    let isOpen = false;
    const nodes = new Map<string, NodeRec>();
    const edgesByNode = new Map<string, SVGPathElement[]>();
    let selectedId: string | null = null;
    let hoveredId: string | null = null;

    // View transform (world → screen): translate(tx ty) scale(s).
    let s = 1;
    let tx = 0;
    let ty = 0;
    const home = { s: 1, tx: 0, ty: 0 };
    let zoomMin = ZOOM_MIN_FLOOR;
    let bbox = { x: 0, y: 0, w: 1, h: 1 };
    let userAdjusted = false;
    let homeAnimId: number | null = null;
    ctx.onCleanup(() => {
      if (homeAnimId !== null) cancelAnimationFrame(homeAnimId);
    });

    // ---- view transform ------------------------------------------------------
    const applyView = (): void => {
      refs.world.setAttribute("transform", `translate(${tx} ${ty}) scale(${s})`);
      // Custom-property bridges (data, not styling — same pattern as the
      // --cc-fold-* / --cc-swatch bridges): the dot grid tracks the zoom.
      refs.stage.style.setProperty("--cc-atlas-gs", `${GRID_STEP_PX * s}px`);
      refs.stage.style.setProperty("--cc-atlas-gp", `${tx}px ${ty}px`);
      refs.zoomPct.textContent = `${Math.round(s * 100)}%`;
    };

    const computeHome = (): void => {
      const W = refs.overlay.clientWidth || window.innerWidth;
      const H = refs.overlay.clientHeight || window.innerHeight;
      const fit = Math.min(W / bbox.w, H / bbox.h) * FIT_PADDING;
      home.s = Math.min(fit, ZOOM_MAX);
      home.tx = (W - bbox.w * home.s) / 2 - bbox.x * home.s;
      home.ty = (H - bbox.h * home.s) / 2 - bbox.y * home.s;
      zoomMin = Math.min(ZOOM_MIN_FLOOR, home.s * 0.75);
    };

    const cancelHomeAnim = (): void => {
      if (homeAnimId !== null) {
        cancelAnimationFrame(homeAnimId);
        homeAnimId = null;
      }
    };

    const goHome = (animate: boolean): void => {
      cancelHomeAnim();
      if (!animate || prefersReducedMotion()) {
        s = home.s;
        tx = home.tx;
        ty = home.ty;
        applyView();
        return;
      }
      const from = { s, tx, ty };
      const t0 = performance.now();
      const step = (now: number): void => {
        if (ctx.signal.aborted) return;
        const p = Math.min(1, (now - t0) / HOME_ANIM_MS);
        const e = 1 - Math.pow(1 - p, 3);
        s = from.s + (home.s - from.s) * e;
        tx = from.tx + (home.tx - from.tx) * e;
        ty = from.ty + (home.ty - from.ty) * e;
        applyView();
        homeAnimId = p < 1 ? requestAnimationFrame(step) : null;
      };
      homeAnimId = requestAnimationFrame(step);
    };

    // ---- tooltip ------------------------------------------------------------------
    const showTip = (rec: NodeRec): void => {
      refs.tipDot.setAttribute("data-cc-topic", rec.topic);
      refs.tipTitle.textContent = rec.title;
      refs.tipPrev.textContent = rec.snippet;
      refs.tip.classList.add("cc-atlas-tip-show");
      // Screen-space anchor above the node; measure, then clamp horizontally.
      const sx = tx + rec.x * s;
      const sy = ty + rec.y * s - rec.r * s - 12;
      setGeometry(refs.tip, { left: 0, top: 0 });
      const w = refs.tip.offsetWidth;
      const left = Math.max(w / 2 + 8, Math.min(window.innerWidth - w / 2 - 8, sx));
      setGeometry(refs.tip, { left, top: Math.max(58, sy) });
    };
    const hideTip = (): void => refs.tip.classList.remove("cc-atlas-tip-show");

    // ---- hover / selection ---------------------------------------------------------
    const setEdges = (id: string, cls: "cc-hot" | "cc-active", on: boolean): void => {
      for (const p of edgesByNode.get(id) ?? []) p.classList.toggle(cls, on);
    };

    const clearHover = (): void => {
      if (!hoveredId) return;
      const rec = nodes.get(hoveredId);
      if (rec) {
        rec.scaler.classList.remove("cc-up");
        setEdges(rec.id, "cc-hot", false);
      }
      hoveredId = null;
      hideTip();
    };

    const setHover = (rec: NodeRec): void => {
      if (hoveredId === rec.id) return;
      clearHover();
      hoveredId = rec.id;
      rec.scaler.classList.add("cc-up");
      setEdges(rec.id, "cc-hot", true);
      showTip(rec);
    };

    const deselect = (): void => {
      if (selectedId) {
        const prev = nodes.get(selectedId);
        if (prev) {
          prev.el.classList.remove("cc-selected");
          setEdges(prev.id, "cc-active", false);
        }
        selectedId = null;
      }
      refs.detail.classList.remove("cc-open");
    };

    const select = (id: string): void => {
      const rec = nodes.get(id);
      if (!rec) return;
      if (selectedId && selectedId !== id) deselect();
      selectedId = id;
      rec.el.classList.add("cc-selected");
      setEdges(id, "cc-active", true);

      refs.pillDot.setAttribute("data-cc-topic", rec.topic);
      refs.pillLbl.textContent = topicLabel(rec.topic);
      refs.dKind.textContent =
        rec.kind === "hub"
          ? `USER QUESTION · Q${rec.qIndex} · ${rec.childCount} SECTION${rec.childCount === 1 ? "" : "S"}`
          : `ANSWER SECTION · UNDER Q${rec.qIndex} · REPLY #${rec.answerNo}`;
      refs.dTitle.textContent = rec.title;
      refs.dBody.textContent = rec.snippet;
      refs.detail.classList.add("cc-open");
    };

    // ---- graph build (fresh from the real conversation, at open time) -----------
    const buildNode = (
      rec: Omit<NodeRec, "el" | "scaler">,
      delayS: number,
      labelBuild: (g: SVGGElement) => void,
    ): void => {
      const g = svgEl(OWNER, "g", {
        class: `cc-atlas-node cc-atlas-${rec.kind}`,
        transform: `translate(${rec.x} ${rec.y})`,
        "data-id": rec.id,
        "data-cc-topic": rec.topic,
      });
      const sc = svgEl(OWNER, "g", { class: "cc-atlas-scaler cc-atlas-enter" }, g);
      sc.style.animationDelay = `${delayS}s`; // timing-only inline style

      if (rec.kind === "hub") {
        svgEl(OWNER, "circle", { class: "cc-atlas-glow", r: "34" }, sc);
        svgEl(OWNER, "circle", { class: "cc-atlas-core", r: String(HUB_R) }, sc);
        svgEl(OWNER, "circle", { class: "cc-atlas-tint", r: String(HUB_R - 7) }, sc);
        const idx = svgEl(
          OWNER,
          "text",
          { class: "cc-atlas-idx", "text-anchor": "middle", dy: "0.36em" },
          sc,
        );
        idx.textContent = `Q${rec.qIndex}`;
        svgEl(OWNER, "circle", { class: "cc-atlas-ring", r: String(HUB_R + 10) }, sc);
      } else {
        svgEl(OWNER, "circle", { class: "cc-atlas-glow", r: String(CHILD_R) }, sc);
        svgEl(OWNER, "circle", { class: "cc-atlas-core", r: String(CHILD_R) }, sc);
        svgEl(OWNER, "circle", { class: "cc-atlas-hole", r: "4" }, sc);
        svgEl(OWNER, "circle", { class: "cc-atlas-ring", r: String(CHILD_R + 8) }, sc);
      }
      labelBuild(g);
      refs.nodeLayer.appendChild(g);
      nodes.set(rec.id, { ...rec, el: g, scaler: sc });
    };

    const buildLegend = (placed: PlacedHub[], satCount: number, partial: boolean): void => {
      refs.legendRows.replaceChildren();
      const present = new Set<TopicId>(placed.map((p) => p.hub.topic));
      for (const def of TOPIC_DEFS) {
        if (!present.has(def.id)) continue;
        const row = ownedEl("div", { owner: OWNER, className: "cc-atlas-legend-row" });
        const sw = ownedEl("span", { owner: OWNER, className: "cc-atlas-dot-sw" });
        sw.setAttribute("data-cc-topic", def.id);
        row.append(sw, def.label);
        refs.legendRows.appendChild(row);
      }
      const countText =
        `${placed.length} question${placed.length === 1 ? "" : "s"} · ` +
        `${satCount} answer section${satCount === 1 ? "" : "s"}` +
        (partial ? " · partial index" : "");
      refs.legendCount.textContent = countText;
      refs.counts.textContent = countText;
      refs.legend.classList.toggle("cc-hidden", placed.length === 0);
    };

    const buildGraph = (): void => {
      clearHover();
      deselect();
      nodes.clear();
      edgesByNode.clear();
      refs.edgeLayer.replaceChildren();
      refs.nodeLayer.replaceChildren();

      const index = ctx.conversation.current();
      const hubs = index ? buildAtlasData(index) : [];
      const layout = computeLayout(hubs);
      bbox = layout.bbox;

      const satCount = hubs.reduce((n, h) => n + h.satellites.length, 0);
      buildLegend(layout.hubs, satCount, index?.source === "dom");
      refs.empty.classList.toggle("cc-hidden", layout.hubs.length > 0);

      // Radial spokes (center → each question) + the conversation anchor.
      // The anchor is a decorative landmark, not a jump target: no
      // .cc-atlas-node class / data-id, so hover and click pass through it
      // exactly like empty stage (click = deselect).
      if (layout.hubs.length > 0) {
        for (const ph of layout.hubs) {
          svgEl(
            OWNER,
            "path",
            { class: "cc-atlas-spine", d: curvePath(layout.center, ph, 0.1) },
            refs.edgeLayer,
          );
        }
        const cg = svgEl(
          OWNER,
          "g",
          {
            class: "cc-atlas-centernode",
            transform: `translate(${layout.center.x} ${layout.center.y})`,
          },
          refs.nodeLayer,
        );
        const csc = svgEl(OWNER, "g", { class: "cc-atlas-scaler cc-atlas-enter" }, cg);
        csc.style.animationDelay = "0.02s"; // timing-only inline style
        svgEl(OWNER, "circle", { class: "cc-atlas-glow", r: String(CENTER_R + 6) }, csc);
        svgEl(OWNER, "circle", { class: "cc-atlas-core", r: String(CENTER_R) }, csc);
        svgEl(OWNER, "circle", { class: "cc-atlas-halo", r: String(CENTER_R + 8) }, csc);
        const clbl = svgEl(
          OWNER,
          "text",
          { class: "cc-atlas-lbl", "text-anchor": "middle", y: String(CENTER_R + 22) },
          cg,
        );
        clbl.style.animationDelay = "0.15s";
        clbl.textContent = clip(index?.name || "This conversation", 36);
      }

      layout.hubs.forEach((ph, hi) => {
        const hubDelay = 0.1 + hi * HUB_STAGGER_S;
        const hubEdges: SVGPathElement[] = [];

        ph.children.forEach((pc, ci) => {
          const delay = hubDelay + 0.14 + ci * CHILD_STAGGER_S;
          const edge = svgEl(
            OWNER,
            "path",
            {
              class: "cc-atlas-edge",
              d: curvePath(ph, pc, 0.14),
              pathLength: "1",
              "data-cc-topic": ph.hub.topic,
            },
            refs.edgeLayer,
          );
          edge.style.animationDelay = `${delay - 0.06}s`; // timing-only
          hubEdges.push(edge);
          edgesByNode.set(pc.sat.id, [edge]);

          buildNode(
            {
              id: pc.sat.id,
              kind: "child",
              topic: ph.hub.topic,
              title: pc.sat.label,
              snippet: pc.sat.snippet,
              x: pc.x,
              y: pc.y,
              r: CHILD_R,
              uuid: pc.sat.uuid,
              headingText: pc.sat.headingText,
              qIndex: ph.hub.qIndex,
              childCount: 0,
              answerNo: pc.sat.answerNo,
            },
            delay,
            (g) => {
              const lbl = svgEl(OWNER, "text", { class: "cc-atlas-lbl" }, g);
              lbl.style.animationDelay = `${delay + 0.15}s`;
              if (pc.side === "right") {
                lbl.setAttribute("text-anchor", "start");
                lbl.setAttribute("x", String(CHILD_R + 9));
                lbl.setAttribute("y", "4");
              } else if (pc.side === "left") {
                lbl.setAttribute("text-anchor", "end");
                lbl.setAttribute("x", String(-(CHILD_R + 9)));
                lbl.setAttribute("y", "4");
              } else if (pc.side === "top") {
                lbl.setAttribute("text-anchor", "middle");
                lbl.setAttribute("x", "0");
                lbl.setAttribute("y", String(-(CHILD_R + 10)));
              } else {
                lbl.setAttribute("text-anchor", "middle");
                lbl.setAttribute("x", "0");
                lbl.setAttribute("y", String(CHILD_R + 18));
              }
              lbl.textContent = pc.sat.label;
            },
          );
        });

        edgesByNode.set(ph.hub.id, hubEdges);
        buildNode(
          {
            id: ph.hub.id,
            kind: "hub",
            topic: ph.hub.topic,
            title: ph.hub.labelLines.join(" "),
            snippet: ph.hub.snippet,
            x: ph.x,
            y: ph.y,
            r: HUB_R,
            uuid: ph.hub.uuid,
            headingText: null,
            qIndex: ph.hub.qIndex,
            childCount: ph.hub.satellites.length,
            answerNo: 0,
          },
          hubDelay,
          (g) => {
            const lbl = svgEl(OWNER, "text", { class: "cc-atlas-lbl" }, g);
            lbl.style.animationDelay = `${hubDelay + 0.15}s`;
            lbl.setAttribute("text-anchor", "middle");
            ph.hub.labelLines.forEach((line, i) => {
              const tspan = svgEl(
                OWNER,
                "tspan",
                { x: "0", y: String(HUB_R + 22 + i * 17) },
                lbl,
              );
              tspan.textContent = line;
            });
          },
        );
      });

      computeHome();
      if (!userAdjusted) goHome(false);
      else applyView();
    };

    // ---- open / close -----------------------------------------------------------
    const open = (): void => {
      if (isOpen) return;
      isOpen = true;
      userAdjusted = false;
      refs.overlay.classList.remove("cc-hidden");
      buildGraph();
      refs.overlay.focus();
      // The graph builds from whatever is cached; make sure the index is
      // fresh — conversation:indexed/updated below rebuilds while open.
      void ctx.conversation.ensure();
    };

    const close = (): void => {
      if (!isOpen) return;
      isOpen = false;
      cancelHomeAnim();
      clearHover();
      deselect();
      refs.overlay.classList.add("cc-hidden");
    };

    ctx.on("ui:atlas-toggle", () => {
      if (isOpen) close();
      else open();
    });
    // The palette shares the z-44 band and this overlay (mounted later in
    // #cc-root) would paint over it — yield the stage when it opens.
    ctx.on("ui:palette-toggle", () => close());
    ctx.on("conversation:indexed", () => {
      if (isOpen) buildGraph();
    });
    ctx.on("conversation:updated", () => {
      if (isOpen) buildGraph();
    });
    ctx.onCleanup(() => close());

    // ---- pan / zoom / click ------------------------------------------------------
    let panning = false;
    let moved = 0;
    let px = 0;
    let py = 0;
    let downTarget: Element | null = null;

    ctx.listen(refs.stage, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0) return;
      cancelHomeAnim();
      panning = true;
      moved = 0;
      px = e.clientX;
      py = e.clientY;
      downTarget = e.target instanceof Element ? e.target : null;
      try {
        refs.stage.setPointerCapture(e.pointerId);
      } catch {
        /* capture unavailable — pan still works via stage events */
      }
      refs.stage.classList.add("cc-grabbing");
      hideTip();
    });

    ctx.listen(refs.stage, "pointermove", (e: PointerEvent) => {
      if (!panning) return;
      const dx = e.clientX - px;
      const dy = e.clientY - py;
      moved += Math.abs(dx) + Math.abs(dy);
      px = e.clientX;
      py = e.clientY;
      tx += dx;
      ty += dy;
      if (moved >= CLICK_SLOP_PX) userAdjusted = true;
      applyView();
    });

    ctx.listen(refs.stage, "pointerup", () => {
      if (!panning) return;
      panning = false;
      refs.stage.classList.remove("cc-grabbing");
      if (moved < CLICK_SLOP_PX) {
        const g = downTarget?.closest<SVGGElement>(".cc-atlas-node") ?? null;
        const id = g?.getAttribute("data-id");
        if (id) select(id);
        else deselect();
      }
      downTarget = null;
    });

    ctx.listen(refs.stage, "pointercancel", () => {
      panning = false;
      refs.stage.classList.remove("cc-grabbing");
    });

    // Cursor-anchored wheel zoom, clamped.
    ctx.listen(
      refs.stage,
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        cancelHomeAnim();
        hideTip();
        const k = Math.exp(-e.deltaY * WHEEL_ZOOM_K);
        const ns = Math.max(zoomMin, Math.min(ZOOM_MAX, s * k));
        const k2 = ns / s;
        if (k2 !== 1) userAdjusted = true;
        tx = e.clientX - (e.clientX - tx) * k2;
        ty = e.clientY - (e.clientY - ty) * k2;
        s = ns;
        applyView();
      },
      { passive: false },
    );

    // Hover (delegated — nodes are rebuilt on every open).
    const recFromEvent = (e: Event): NodeRec | null => {
      const t = e.target;
      if (!(t instanceof Element)) return null;
      const g = t.closest<SVGGElement>(".cc-atlas-node");
      const id = g?.getAttribute("data-id");
      return id ? (nodes.get(id) ?? null) : null;
    };

    // Drop the entrance class once its animation finishes — its `both` fill
    // would otherwise pin the scaler's transform and defeat the hover scale.
    // (Under reduced motion the animation never runs and the class is inert.)
    ctx.listen(refs.nodeLayer, "animationend", (e: AnimationEvent) => {
      const t = e.target;
      if (t instanceof Element && t.classList.contains("cc-atlas-enter")) {
        t.classList.remove("cc-atlas-enter");
      }
    });

    ctx.listen(refs.svg, "pointerover", (e: PointerEvent) => {
      if (panning) return;
      const rec = recFromEvent(e);
      if (rec) setHover(rec);
    });
    ctx.listen(refs.svg, "pointerout", (e: PointerEvent) => {
      const rec = recFromEvent(e);
      if (!rec || rec.id !== hoveredId) return;
      const rt = e.relatedTarget;
      if (rt instanceof Node && rec.el.contains(rt)) return;
      clearHover();
    });

    // ---- controls ---------------------------------------------------------------
    ctx.listen(refs.resetBtn, "click", () => {
      userAdjusted = false;
      goHome(true);
    });
    ctx.listen(refs.closeBtn, "click", () => close());
    ctx.listen(refs.detailClose, "click", () => deselect());

    ctx.listen(refs.jumpBtn, "click", () => {
      if (!selectedId) return;
      const rec = nodes.get(selectedId);
      if (!rec) return;
      // The real seek — identical mechanism to the outline's jump.
      ctx.matcher.jumpTo(rec.uuid, rec.headingText ? { headingText: rec.headingText } : {});
      if (prefersReducedMotion()) {
        close();
        return;
      }
      const pulse = svgEl(
        OWNER,
        "circle",
        { class: "cc-atlas-pulse", r: String(rec.r + 6) },
        rec.scaler,
      );
      ctx.setTimeout(() => pulse.remove(), PULSE_MS);
      ctx.setTimeout(() => close(), CLOSE_AFTER_JUMP_MS);
    });

    // Esc: deselect first, then close. Captured so claude's own handlers
    // never see it while the atlas is open.
    ctx.listen(
      window,
      "keydown",
      (e: KeyboardEvent) => {
        if (!isOpen || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        if (selectedId) deselect();
        else close();
      },
      { capture: true },
    );

    ctx.listen(window, "resize", () => {
      if (!isOpen) return;
      computeHome();
      if (!userAdjusted) goHome(false);
    });
  },
};
