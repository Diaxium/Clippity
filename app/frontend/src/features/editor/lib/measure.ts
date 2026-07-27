/**
 * Measurement / dimension lines (Fork A-F3) — pure geometry + formatting, no
 * React, no store.
 *
 * ### Why this needs its own module
 *
 * A dimension is a line *plus* decorations that live outside the line: serif
 * ticks or arrowheads perpendicular to it, and a rotated label pill sitting in a
 * break in the shaft. Nothing either renderer already reads can express that —
 * it is the same position window chrome (ADR 0022) and the spotlight scrim
 * (ADR 0023) were in — so the answer is the same one those reached: **one
 * shared module computes every number, and each renderer only decides how to
 * *emit* it** (SVG elements vs Canvas2D calls). {@link measureGeometry} is the
 * whole drawing as data; `SceneNodeView`'s `MeasureMarks` and `render.ts`'s
 * `drawMeasure` are two spellings of it, so they cannot drift.
 *
 * ### The measurement is derived, never stored
 *
 * Scene space is capture px at 1:1 (`sceneFromImage` sizes the page to the
 * bitmap), so the distance between the line's endpoints **is** the measurement.
 * Storing the number alongside would let it drift from the line the moment
 * either endpoint moved — the label reads the geometry every render instead.
 * {@link MeasureSpec.scale} and `unit` only re-express that one true length.
 *
 * ### Text is measured, not laid out
 *
 * Neither renderer can share the other's text metrics (jsdom has no Canvas2D at
 * all — see the test convention), so the label's pill is sized here from an
 * average advance width and *both* renderers center the text inside that same
 * pill. An estimate that is slightly loose is fine; an estimate that differs
 * between the two renderers would not be. Same reasoning that made the Windows
 * caption buttons strokes rather than glyphs (ADR 0022).
 */

import type {
  ArrowNode,
  LineNode,
  MeasureCap,
  MeasureSpec,
  Rect,
  SceneNode,
  Vec2,
} from "../types";
import { isLineLike, lineEndpoints } from "../types";
import { readableInk, topStroke } from "./paint";

/** Below this the line is a dot, and there is no direction to lay a dimension
 *  out along — the mark renders as nothing rather than as NaN. */
const MIN_MEASURE_LENGTH = 0.5;

/** Bounds on {@link MeasureSpec.scale}. A zero or negative factor would report
 *  a nonsense length, and an unbounded one lets a mistyped value blow the label
 *  pill past the page. */
export const MIN_MEASURE_SCALE = 0.001;
export const MAX_MEASURE_SCALE = 1000;

export function clampMeasureScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(MIN_MEASURE_SCALE, Math.min(MAX_MEASURE_SCALE, scale));
}

/**
 * Whether this node can carry a measurement: a line or an arrow.
 *
 * A dimension's defining property is that it has *two endpoints* — which is
 * exactly what line-like nodes model (signed width/height encode the a→b
 * vector) and what box nodes do not. Other types return false so a stale spec is
 * inert rather than half-rendered, the guard {@link measureOf} reads.
 */
export function canCarryMeasure(node: SceneNode): node is LineNode | ArrowNode {
  return isLineLike(node);
}

/** The node's measure spec, or null — including for types that can't carry one. */
export function measureOf(node: SceneNode): MeasureSpec | null {
  const spec = node.measure;
  if (!spec || !canCarryMeasure(node)) return null;
  return spec;
}

// ---------- the number ----------

/** The measured distance in scene px — the plain length of the line. */
export function measureLength(node: SceneNode): number {
  const { a, b } = lineEndpoints(node as LineNode);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * The number the label shows: the scene length re-expressed through the spec's
 * scale.
 */
export function measureValue(node: SceneNode, spec: MeasureSpec): number {
  return measureLength(node) * clampMeasureScale(spec.scale);
}

/**
 * The label's text.
 *
 * Rounded to a tenth: a dimension read off a screenshot is never more precise
 * than that, and a full float would make the pill jitter in width through a
 * drag. Trailing `.0` is dropped so the common whole-pixel case reads "248 px"
 * rather than "248.0 px".
 */
export function formatMeasure(value: number, unit: string): string {
  const rounded = Math.round(value * 10) / 10;
  const num = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  const suffix = unit.trim();
  return suffix ? `${num} ${suffix}` : num;
}

/** Units the panel offers. Free text would be more flexible, but these cover
 *  every case a screen measurement actually has, and a picker can't be typo'd
 *  into a label nobody meant. */
export const MEASURE_UNITS: readonly { id: string; label: string }[] = [
  { id: "px", label: "px" },
  { id: "pt", label: "pt" },
  { id: "dp", label: "dp" },
  { id: "mm", label: "mm" },
  { id: "cm", label: "cm" },
  { id: "in", label: "in" },
  { id: "", label: "none" },
];

/** Cap styles the panel offers. */
export const MEASURE_CAPS: readonly { id: MeasureCap; label: string }[] = [
  { id: "tick", label: "Ticks" },
  { id: "arrow", label: "Arrows" },
];

// ---------- drawing model ----------

/** A straight segment to stroke, in scene space. */
export type MeasureSegment = readonly [Vec2, Vec2];

/**
 * The length label: a rounded pill with the number centered in it.
 *
 * Both renderers place it by rotating `rotation` degrees about (`cx`,`cy`) and
 * drawing a `width`×`height` pill centered there — an SVG `<g transform=
 * "rotate(…)">` and a Canvas `translate`+`rotate` are two spellings of that one
 * transform.
 */
export interface MeasureLabel {
  text: string;
  /** Pill center in scene space (the shaft's midpoint). */
  cx: number;
  cy: number;
  /** Degrees clockwise. The shaft's own angle, flipped by 180° when that would
   *  leave the text upside down, so a dimension always reads left-to-right. */
  rotation: number;
  width: number;
  height: number;
  /** Corner radius — half the height, i.e. a pill. */
  radius: number;
  /** Font size in scene px. */
  size: number;
  /** Text ink, contrast-picked against `plate`. */
  color: string;
  /** Pill fill — the mark's stroke color, so the label belongs to the line. */
  plate: string;
}

/** Everything either renderer needs to draw a dimension line. */
export interface MeasureGeometry {
  a: Vec2;
  b: Vec2;
  /** Stroke color / width / opacity, from the node's top stroke. */
  color: string;
  width: number;
  opacity: number;
  /** Shaft segments — two, split around the label; fewer when the label eats
   *  the whole span. */
  shaft: readonly MeasureSegment[];
  /** Perpendicular serifs at the endpoints (`caps: "tick"`), else empty. */
  ticks: readonly MeasureSegment[];
  /** Filled arrowhead triangles at the endpoints (`caps: "arrow"`), else
   *  empty. */
  heads: readonly Vec2[][];
  label: MeasureLabel;
}

/** Serif half-length, and the arrowhead's length — both scaled off the stroke
 *  width so a heavier dimension keeps its proportions. */
const TICK_HALF = (width: number): number => Math.max(4, width * 2.6);
const HEAD_LEN = (width: number): number => Math.max(8, width * 3.2);
/** Arrowhead half-angle (radians), matching the plain arrow node's barbs. */
const HEAD_SPREAD = 0.5;

/** Label type scale, driven by the stroke width the user already controls. */
const LABEL_SIZE = (width: number): number =>
  Math.max(12, Math.min(36, width * 5));
/** Mean advance width of a digit in Inter at weight 600, as a fraction of the
 *  font size. The pill is sized from this rather than from either renderer's
 *  text metrics — see the module header. */
const LABEL_ADVANCE = 0.58;
/** Clear space between the pill and where the shaft resumes. */
const LABEL_GAP = 4;

/** Fallback stroke for a dimension whose strokes were all deleted or hidden —
 *  the mark stays visible and editable instead of vanishing with no way back. */
const FALLBACK_STROKE = { color: "#f24822", width: 2, opacity: 1 };

/**
 * The whole dimension as data, or null when the node carries no measure or is
 * too short to have a direction.
 *
 * Scene-space and rotation-free, like `polygonOutline` and `calloutOutline`:
 * line-like nodes always have `rotation === 0` and encode their direction in
 * signed width/height, so there is no transform for the two renderers to
 * disagree about.
 */
export function measureGeometry(node: SceneNode): MeasureGeometry | null {
  const spec = measureOf(node);
  if (!spec) return null;
  const { a, b } = lineEndpoints(node as LineNode);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < MIN_MEASURE_LENGTH) return null;

  const s = topStroke(node.strokes) ?? FALLBACK_STROKE;
  const width = Math.max(0.5, s.width);
  const color = s.color;

  // Unit vectors along the shaft and perpendicular to it.
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const px = -uy;
  const py = ux;
  const at = (d: number, off = 0): Vec2 => ({
    x: a.x + ux * d + px * off,
    y: a.y + uy * d + py * off,
  });

  // Label first: its pill width decides where the shaft breaks.
  const size = LABEL_SIZE(width);
  const text = formatMeasure(measureValue(node, spec), spec.unit);
  const padX = size * 0.5;
  const padY = size * 0.26;
  const labelW = text.length * size * LABEL_ADVANCE + padX * 2;
  const labelH = size + padY * 2;
  const mid = at(len / 2);
  const angleDeg = (Math.atan2(uy, ux) * 180) / Math.PI;
  const label: MeasureLabel = {
    text,
    cx: mid.x,
    cy: mid.y,
    // Keep the text within a quarter turn of upright: past ±90° the same line
    // read from the other end is the same dimension, so flip rather than
    // render the number upside down.
    rotation:
      angleDeg > 90
        ? angleDeg - 180
        : angleDeg <= -90
          ? angleDeg + 180
          : angleDeg,
    width: labelW,
    height: labelH,
    // Pill, but never a radius wider than the box it rounds — Canvas2D's
    // `arcTo` would draw a distorted corner where SVG's `rx` silently clamps.
    radius: Math.min(labelH, labelW) / 2,
    size,
    color: readableInk(color),
    plate: color,
  };

  // Arrow caps eat the shaft's ends so the barbs stay sharp — the same inset
  // `drawLine`/`LineView` already apply to a plain arrow.
  const inset =
    spec.caps === "arrow"
      ? Math.min(HEAD_LEN(width) * Math.cos(HEAD_SPREAD), len / 2)
      : 0;
  const half = labelW / 2 + LABEL_GAP;
  const shaft: MeasureSegment[] = [];
  if (len / 2 - half > inset) shaft.push([at(inset), at(len / 2 - half)]);
  if (len / 2 + half < len - inset)
    shaft.push([at(len / 2 + half), at(len - inset)]);

  const ticks: MeasureSegment[] = [];
  const heads: Vec2[][] = [];
  if (spec.caps === "tick") {
    const t = TICK_HALF(width);
    ticks.push([at(0, -t), at(0, t)], [at(len, -t), at(len, t)]);
  } else {
    heads.push(arrowHead(a, -ux, -uy, width), arrowHead(b, ux, uy, width));
  }

  return {
    a,
    b,
    color,
    width,
    opacity: s.opacity,
    shaft,
    ticks,
    heads,
    label,
  };
}

/** A filled arrowhead at `tip`, opening back along `-(dx,dy)`. Same barb length
 *  and spread as the arrow node's head, so the two read as one family. */
function arrowHead(tip: Vec2, dx: number, dy: number, width: number): Vec2[] {
  const l = HEAD_LEN(width);
  const angle = Math.atan2(dy, dx);
  return [
    tip,
    {
      x: tip.x - l * Math.cos(angle - HEAD_SPREAD),
      y: tip.y - l * Math.sin(angle - HEAD_SPREAD),
    },
    {
      x: tip.x - l * Math.cos(angle + HEAD_SPREAD),
      y: tip.y - l * Math.sin(angle + HEAD_SPREAD),
    },
  ];
}

/**
 * The scene-space box the dimension actually paints, or null when it paints
 * nothing.
 *
 * A line-like node's own frame is the bare segment — zero-height for a
 * horizontal dimension — while the ticks, arrowheads and label pill all sit
 * *outside* it. `exportBounds` unions this in so exporting a dimension on its
 * own doesn't slice its decorations off, the way window chrome needed
 * (ADR 0022). Deliberately not folded into `rotatedAABB`, which also backs
 * selection chrome, hit-testing and zoom-to-selection where the node's own
 * segment is the right answer.
 */
export function measureBounds(node: SceneNode): Rect | null {
  const g = measureGeometry(node);
  if (!g) return null;
  const pts: Vec2[] = [g.a, g.b];
  for (const [p, q] of [...g.shaft, ...g.ticks]) pts.push(p, q);
  for (const head of g.heads) pts.push(...head);
  pts.push(...labelCorners(g.label));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // Half the stroke straddles each segment; grow so the ink is inside the box.
  const pad = g.width / 2;
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/** The label pill's four corners in scene space, rotation applied. */
export function labelCorners(label: MeasureLabel): Vec2[] {
  const rad = (label.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = label.width / 2;
  const hh = label.height / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([dx, dy]) => ({
    x: label.cx + dx! * cos - dy! * sin,
    y: label.cy + dx! * sin + dy! * cos,
  }));
}
