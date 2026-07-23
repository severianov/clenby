/**
 * Conversation Atlas — radial/centric (mind-map) layout.
 *
 * Computed fresh from the real message data at open time (nothing hardcoded).
 * The conversation itself sits at the world origin as a small anchor node;
 * the user's questions are spaced evenly on a ring around it (Q1 at twelve
 * o'clock, then clockwise = chronological), and each question's answer
 * sections fan OUTWARD from their hub, splayed around the hub's radial
 * direction so neighboring fans stay apart. The ring grows with the question
 * count and each fan's reach grows with its satellite count, so the whole
 * graph stays a compact centered disc that the fit-to-viewport transform can
 * frame in one glance — no wide serpentine scatter. Deterministic: the only
 * "organic" wobble is a per-uuid hash jitter, stable across reopens. Pure
 * math — no DOM.
 */

import type { AtlasHub, AtlasSatellite } from "./data";

export type LabelSide = "left" | "right" | "top" | "bottom";

export interface PlacedSatellite {
  sat: AtlasSatellite;
  x: number;
  y: number;
  side: LabelSide;
}

export interface PlacedHub {
  hub: AtlasHub;
  x: number;
  y: number;
  children: PlacedSatellite[];
}

export interface AtlasLayout {
  hubs: PlacedHub[];
  /** The conversation anchor node — always the world origin. */
  center: { x: number; y: number };
  /** World bounding box for the fit-to-viewport "home" transform. */
  bbox: { x: number; y: number; w: number; h: number };
}

export const HUB_R = 30;
export const CHILD_R = 12;
/** Radius of the central conversation-anchor node. */
export const CENTER_R = 16;

/** Extra margin around node centers for labels/glows when computing bbox. */
const BBOX_MARGIN = 185;
/** Question ring: minimum radius, and minimum arc length between hubs so
 *  neighbor hubs (Ø60 + two label lines) never crowd each other. */
const RING_MIN_R = 290;
const RING_MIN_R_SMALL = 230; // 1–2 questions — hug the center
const HUB_ARC = 265;
/** Satellite fans: base hub→child distance, arc length between siblings,
 *  and the widest allowed splay around the hub's outward direction. */
const ORBIT_BASE = 118;
const CHILD_ARC = 64;
const FAN_MAX = (150 * Math.PI) / 180;
const FAN_MIN = (40 * Math.PI) / 180;
/** Alternate siblings step outward a little so side labels breathe. */
const CHILD_STAGGER = 26;

/** Tiny deterministic hash → [0, 1) — jitter must be stable across rebuilds
 *  so the map doesn't reshuffle on every open of the same conversation. */
function hash01(seed: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Label side from the node's outward angle — radial labels point away from
 *  the graph center so they never fight the connectors. */
function sideForAngle(a: number): LabelSide {
  const cos = Math.cos(a);
  if (Math.abs(cos) >= 0.55) return cos > 0 ? "right" : "left";
  // SVG y grows downward: sin < 0 is visually above the hub.
  return Math.sin(a) < 0 ? "top" : "bottom";
}

/** Quadratic curve with a perpendicular bow — spoke + edge path data. */
export function curvePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  bow: number,
): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const nx = -dy / len;
  const ny = dx / len;
  const k = len * bow;
  return `M${a.x} ${a.y} Q${mx + nx * k} ${my + ny * k} ${b.x} ${b.y}`;
}

export function computeLayout(hubs: AtlasHub[]): AtlasLayout {
  const n = hubs.length;
  const center = { x: 0, y: 0 };
  const placed: PlacedHub[] = [];
  if (n === 0) return { hubs: placed, center, bbox: { x: 0, y: 0, w: 1, h: 1 } };

  // Question ring — evenly spaced spokes, sized so hubs keep HUB_ARC apart.
  const ringR = n <= 2 ? RING_MIN_R_SMALL : Math.max(RING_MIN_R, (n * HUB_ARC) / (2 * Math.PI));
  // Fan splay cap: generous for few questions, tighter (never below FAN_MIN)
  // as spokes multiply, so adjacent fans stay in their own sector.
  const fanCap = Math.max(FAN_MIN, Math.min(FAN_MAX, ((2 * Math.PI) / n) * 1.35));

  hubs.forEach((hub, i) => {
    // Q1 at twelve o'clock, then clockwise = chronological reading order.
    const spoke = -Math.PI / 2 + (i / n) * 2 * Math.PI;
    const x = center.x + Math.cos(spoke) * ringR;
    const y = center.y + Math.sin(spoke) * ringR;

    const count = hub.satellites.length;
    // Grow the fan's reach instead of its width when a hub is crowded — the
    // splay never exceeds fanCap, so deep answers spike outward, not sideways.
    const orbit =
      count > 1 ? Math.max(ORBIT_BASE, ((count - 1) * CHILD_ARC) / fanCap) : ORBIT_BASE;
    const fan = count > 1 ? Math.min(fanCap, ((count - 1) * CHILD_ARC) / orbit) : 0;

    const children: PlacedSatellite[] = hub.satellites.map((sat, k) => {
      const t = count > 1 ? k / (count - 1) : 0.5;
      const ja = (hash01(sat.id, 5) - 0.5) * 0.06;
      const a = spoke - fan / 2 + t * fan + ja;
      const r = orbit + (k % 2) * CHILD_STAGGER + (hash01(sat.id, 6) - 0.5) * 16;
      return {
        sat,
        x: x + Math.cos(a) * r,
        y: y + Math.sin(a) * r,
        side: sideForAngle(a),
      };
    });

    placed.push({ hub, x, y, children });
  });

  // Bounding box over the anchor + every node center, plus label margin.
  let minX = center.x;
  let minY = center.y;
  let maxX = center.x;
  let maxY = center.y;
  for (const p of placed) {
    const pts = [{ x: p.x, y: p.y }, ...p.children];
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  return {
    hubs: placed,
    center,
    bbox: {
      x: minX - BBOX_MARGIN,
      y: minY - BBOX_MARGIN,
      w: maxX - minX + BBOX_MARGIN * 2,
      h: maxY - minY + BBOX_MARGIN * 2,
    },
  };
}
