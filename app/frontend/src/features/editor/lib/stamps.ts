/**
 * Stamps — the bundled icon marks (Fork A-F4). Pure geometry + catalog, no
 * React, no store.
 *
 * ### Fork A-F4 resolved: a bundled **vector** set, not emoji glyphs
 *
 * The fork asked "a small bundled emoji/icon set vs user-supplied assets". Both
 * alternatives are answered by what the editor already has:
 *
 * - **User-supplied assets already ship.** An image node with a data-URI fill is
 *   exactly "stamp your own PNG", complete with scale/align controls. Building a
 *   second path to the same place would have added a feature nobody gained.
 * - **Emoji glyphs can't hold the two-renderer invariant.** A glyph is rendered
 *   by whichever emoji font the *machine* has, so the same document would export
 *   differently on two machines — and the SVG text layout and Canvas2D
 *   `fillText` don't share metrics even on one. That is the reasoning that made
 *   the Windows caption buttons strokes rather than glyphs (ADR 0022) and that
 *   recommends bundled fonts for Fork F1.
 *
 * So a stamp is **path data this module owns**: authored on a 24-unit grid (the
 * Lucide grid the toolbar icons already use), mapped into the node's box, and
 * handed to both renderers as **one `d` string to fill and one to stroke**. That
 * is the tightest form of the ADR 0023 contract — sharing the path itself rather
 * than the numbers — so the branches cannot drift, and a stamp exports
 * byte-identically anywhere.
 *
 * ### The glyph is fit, never stretched
 *
 * {@link stampBox} is the largest **centered square** inside the node's frame, so
 * a stamp dragged out at any proportion still draws an undistorted icon. The
 * tool squares the drag as it's drawn, so in practice the box *is* the frame;
 * the fit is what makes a later non-uniform resize harmless rather than
 * something either renderer has to special-case.
 *
 * ### Ink and halo
 *
 * The glyph has two parts: sub-paths meant to be **filled** ({@link
 * StampGeometry.fillD}) and sub-paths meant to be **stroked** at the icon's own
 * line weight ({@link StampGeometry.strokeD}) — a check is a polyline, a star is
 * an area, a warning sign is both. Together they are the *ink*, and the node's
 * `fills` paint them.
 *
 * The node's `strokes` are then the **halo**: the same two paths drawn
 * underneath at a widened weight ({@link stampHaloWeight} /
 * {@link stampOutlineWeight}), which is the classic outlined-text trick and the
 * thing that makes a mark read on a busy screenshot. It also means the Stroke
 * panel controls something real on a stamp instead of sitting there inert.
 * Stroke **align** has no meaning for a halo (a glyph has no single inside) and
 * is ignored by both renderers.
 */

import {
  nodeBounds,
  type RectangleNode,
  type Rect,
  type SceneNode,
  type StampKind,
  type StampSpec,
  type Vec2,
} from "../types";

const DEG = Math.PI / 180;

/** The authoring grid every icon below is drawn on — Lucide's 24×24, so a
 *  stamp and the toolbar icon that offers it share proportions. */
const STAMP_GRID = 24;

/** Below this the box is a speck: the mark renders as nothing rather than as a
 *  sub-pixel smudge (the {@link measureGeometry} guard's counterpart). */
const MIN_STAMP_SIDE = 1;

// ---------------------------------------------------------------------------
// Path command model
// ---------------------------------------------------------------------------

/**
 * One path command on the 24-grid. Deliberately **cubics only** — no elliptical
 * arcs. `A` carries large-arc/sweep flags that are ambiguous at exactly 180°,
 * and its radii get silently scaled up when the endpoints don't fit; a cubic has
 * none of that, so the emitted string means one thing in an SVG `d` and in a
 * `Path2D`. {@link arc} turns the arcs the icons actually want into cubics.
 */
type Cmd =
  | readonly ["M", number, number]
  | readonly ["L", number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];

/** A point on the circle `(cx,cy,r)` at `deg` — y-down, 0° = +x, so 90° is
 *  below the center and −90° above it. Callers use it for the `M` that opens an
 *  {@link arc}. */
function arcPoint(cx: number, cy: number, r: number, deg: number): Vec2 {
  return { x: cx + r * Math.cos(deg * DEG), y: cy + r * Math.sin(deg * DEG) };
}

/**
 * Cubic segments approximating the circular arc from `from`° to `to`° — the
 * continuation of a path already sitting at `arcPoint(…, from)`.
 *
 * Split into ≤90° pieces so the standard `k = 4/3·tan(θ/4)` handle length stays
 * within a rounding error of the true circle. Sweeping backwards (a `to` below
 * `from`) is how the icons go counter-clockwise on screen.
 */
function arc(
  cx: number,
  cy: number,
  r: number,
  from: number,
  to: number
): Cmd[] {
  const steps = Math.max(1, Math.ceil(Math.abs(to - from) / 90));
  const step = ((to - from) / steps) * DEG;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: Cmd[] = [];
  for (let i = 0; i < steps; i++) {
    const a0 = from * DEG + step * i;
    const a1 = a0 + step;
    const p0 = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
    const p1 = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
    out.push([
      "C",
      p0.x - k * r * Math.sin(a0),
      p0.y + k * r * Math.cos(a0),
      p1.x + k * r * Math.sin(a1),
      p1.y - k * r * Math.cos(a1),
      p1.x,
      p1.y,
    ]);
  }
  return out;
}

/** A closed circle, opened at its top. */
function circle(cx: number, cy: number, r: number): Cmd[] {
  const top = arcPoint(cx, cy, r, -90);
  return [["M", top.x, top.y], ...arc(cx, cy, r, -90, 270), ["Z"]];
}

/** A closed rounded rectangle. */
function roundRect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): Cmd[] {
  const out: Cmd[] = [["M", x + r, y]];
  const corner = (cx: number, cy: number, from: number): void => {
    out.push(...arc(cx, cy, r, from, from + 90));
  };
  out.push(["L", x + w - r, y]);
  corner(x + w - r, y + r, -90);
  out.push(["L", x + w, y + h - r]);
  corner(x + w - r, y + h - r, 0);
  out.push(["L", x + r, y + h]);
  corner(x + r, y + h - r, 90);
  out.push(["L", x, y + r]);
  corner(x + r, y + r, 180);
  out.push(["Z"]);
  return out;
}

/** A closed star with `points` outer vertices, first point straight up. */
function star(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  points: number
): Cmd[] {
  const out: Cmd[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (-90 + (180 / points) * i) * DEG;
    out.push([i === 0 ? "M" : "L", cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  out.push(["Z"]);
  return out;
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/** One bundled icon: what to fill, what to stroke, and how heavy its ink is. */
interface StampDef {
  kind: StampKind;
  label: string;
  /** Sub-paths painted as areas. Filled **even-odd**, so a nested sub-path
   *  (the pin's hole, the lock's keyhole) reads as a hole. */
  fill: readonly Cmd[];
  /** Sub-paths painted as lines at {@link weight}. */
  stroke: readonly Cmd[];
  /** Ink line weight on the 24-grid. Per-icon, because a check wants a bolder
   *  line than an info circle's outline. */
  weight: number;
}

/**
 * The bundled set — twelve marks chosen for what a screenshot actually gets
 * annotated with: a verdict (check/cross), a caution (warning/info/question), an
 * emphasis (star/heart/flag/pin), a state (lock), and a gesture (cursor/idea).
 *
 * A short curated list rather than a browsable emoji tray on purpose: the value
 * of a stamp is that it reads instantly at 32 px, which is a property of the
 * drawing, not of the size of the menu.
 */
const CATALOG: readonly StampDef[] = [
  {
    kind: "check",
    label: "Check",
    weight: 3.2,
    fill: [],
    stroke: [
      ["M", 4.4, 12.6],
      ["L", 9.6, 17.8],
      ["L", 19.6, 6.4],
    ],
  },
  {
    kind: "cross",
    label: "Cross",
    weight: 3.2,
    fill: [],
    stroke: [
      ["M", 6.2, 6.2],
      ["L", 17.8, 17.8],
      ["M", 17.8, 6.2],
      ["L", 6.2, 17.8],
    ],
  },
  {
    kind: "warning",
    label: "Warning",
    weight: 2.4,
    fill: circle(12, 17.6, 1.35),
    stroke: [
      ["M", 12, 3.4],
      ["L", 22, 20.4],
      ["L", 2, 20.4],
      ["Z"],
      ["M", 12, 9],
      ["L", 12, 14.4],
    ],
  },
  {
    kind: "info",
    label: "Info",
    weight: 2.4,
    fill: circle(12, 7.5, 1.35),
    stroke: [...circle(12, 12, 9), ["M", 12, 11.4], ["L", 12, 17]],
  },
  {
    kind: "question",
    label: "Question",
    weight: 2.4,
    fill: circle(12, 17.4, 1.35),
    stroke: [
      ...circle(12, 12, 9),
      // The hook: three quarters of a circle from its left side, over the top
      // and down the right, then a short stem toward the dot.
      ["M", 9.1, 9.4],
      ...arc(12, 9.4, 2.9, 180, 450),
      ["L", 12, 14.6],
    ],
  },
  {
    kind: "star",
    label: "Star",
    weight: 2.4,
    fill: star(12, 12, 9.2, 3.9, 5),
    stroke: [],
  },
  {
    kind: "heart",
    label: "Heart",
    weight: 2.4,
    fill: [
      ["M", 12, 20.8],
      ["C", 12, 20.8, 3.1, 15.2, 3.1, 9.1],
      ["C", 3.1, 6.2, 5.4, 3.9, 8.3, 3.9],
      ["C", 10.1, 3.9, 11.4, 4.8, 12, 6],
      ["C", 12.6, 4.8, 13.9, 3.9, 15.7, 3.9],
      ["C", 18.6, 3.9, 20.9, 6.2, 20.9, 9.1],
      ["C", 20.9, 15.2, 12, 20.8, 12, 20.8],
      ["Z"],
    ],
    stroke: [],
  },
  {
    kind: "flag",
    label: "Flag",
    weight: 2.4,
    fill: [
      ["M", 6.2, 3.9],
      ["L", 19.2, 3.9],
      ["L", 16.2, 8.7],
      ["L", 19.2, 13.5],
      ["L", 6.2, 13.5],
      ["Z"],
    ],
    stroke: [
      ["M", 5.1, 20.8],
      ["L", 5.1, 3.4],
    ],
  },
  {
    kind: "pin",
    label: "Pin",
    weight: 2.4,
    fill: [
      // Teardrop: the tip, swept up into a circle's right side, over the top,
      // and back down to the tip. The second sub-path is the hole (even-odd).
      ["M", 12, 21.8],
      ["C", 13.6, 18.6, 19, 13.4, 19, 9.6],
      ...arc(12, 9.6, 7, 0, -180),
      ["C", 5, 13.4, 10.4, 18.6, 12, 21.8],
      ["Z"],
      ...circle(12, 9.6, 2.7),
    ],
    stroke: [],
  },
  {
    kind: "lock",
    label: "Lock",
    weight: 2.4,
    fill: [...roundRect(4.4, 10.6, 15.2, 10.2, 2.2), ...circle(12, 15.7, 1.6)],
    stroke: [
      ["M", 8.4, 10.6],
      ["L", 8.4, 7.6],
      ...arc(12, 7.6, 3.6, 180, 360),
      ["L", 15.6, 10.6],
    ],
  },
  {
    kind: "cursor",
    label: "Cursor",
    weight: 2.4,
    fill: [
      ["M", 6, 3.2],
      ["L", 6, 19.6],
      ["L", 10.2, 15.6],
      ["L", 12.9, 21.4],
      ["L", 15.9, 20],
      ["L", 13.1, 14.4],
      ["L", 18.6, 14],
      ["Z"],
    ],
    stroke: [],
  },
  {
    kind: "idea",
    label: "Idea",
    weight: 2.2,
    fill: [],
    stroke: [
      // The glass, opened at the right shoulder and swept over the top, then
      // drawn down into the neck and closed across the base.
      ["M", 15.785, 15.206],
      ...arc(12, 9.8, 6.6, 55, -235),
      ["C", 8.9, 16, 9.4, 16.8, 9.4, 17.8],
      ["L", 14.6, 17.8],
      ["C", 14.6, 16.8, 15.1, 16, 15.785, 15.206],
      ["Z"],
      ["M", 9.8, 20.6],
      ["L", 14.2, 20.6],
    ],
  },
];

/** The catalog in picker order — the panel and the tool both walk this. */
export const STAMPS: readonly { kind: StampKind; label: string }[] =
  CATALOG.map((d) => ({ kind: d.kind, label: d.label }));

const BY_KIND = new Map(CATALOG.map((d) => [d.kind, d]));

/** The icon a spec names, falling back to the first of the set so a scene
 *  written by a future version (or hand-edited) still draws *something* rather
 *  than an invisible node. */
function defOf(kind: StampKind): StampDef {
  return BY_KIND.get(kind) ?? CATALOG[0]!;
}

/** Display name for an icon — the layer name a fresh stamp takes, and the
 *  picker's tooltip. */
export function stampLabel(kind: StampKind): string {
  return defOf(kind).label;
}

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

/**
 * Whether this node can carry a stamp: a rectangle.
 *
 * A stamp's defining geometry is a box the glyph is fit into — which is what a
 * rectangle models and what the tool draws. Other types return false so a spec
 * stranded on some other shape is inert rather than half-rendered, the guard
 * {@link stampOf} reads (the {@link canCarryMeasure} contract).
 */
export function canCarryStamp(node: SceneNode): node is RectangleNode {
  return node.type === "rectangle";
}

/** The node's stamp spec, or null — including for types that can't carry one. */
export function stampOf(node: SceneNode): StampSpec | null {
  const spec = node.stamp;
  if (!spec || !canCarryStamp(node)) return null;
  return spec;
}

/**
 * The square the glyph is drawn into: the largest one that fits the node's
 * frame, centered.
 *
 * Fitting rather than stretching is what lets the frame be any proportion
 * without either renderer having to decide what a squashed check looks like —
 * and it keeps the scale uniform, so the icon's line weight scales with it
 * instead of turning elliptical.
 */
export function stampBox(node: SceneNode): Rect {
  const b = nodeBounds(node);
  const side = Math.min(b.width, b.height);
  return {
    x: b.x + (b.width - side) / 2,
    y: b.y + (b.height - side) / 2,
    width: side,
    height: side,
  };
}

// ---------------------------------------------------------------------------
// The drawing
// ---------------------------------------------------------------------------

/** Everything either renderer needs to draw a stamp. */
export interface StampGeometry {
  /** Sub-paths to fill, **even-odd**, in scene space. Empty for a purely
   *  linear icon (the check). */
  fillD: string;
  /** Sub-paths to stroke at {@link weight}, in scene space. Empty for a purely
   *  areal icon (the star). */
  strokeD: string;
  /** The icon's own line weight in scene px. */
  weight: number;
  /** The square the glyph was fit into — the mark's real extent, which sits
   *  inside the node's frame and so never grows the export region. */
  box: Rect;
}

/** Path coordinates are rounded to a thousandth: far below a pixel at any
 *  export scale, and it keeps the two renderers' strings byte-identical
 *  instead of differing in float noise. */
function num(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** Map a command list from the 24-grid into `box`, as an SVG/`Path2D` `d`. */
function emit(cmds: readonly Cmd[], box: Rect): string {
  const s = box.width / STAMP_GRID;
  const px = (x: number): string => num(box.x + x * s);
  const py = (y: number): string => num(box.y + y * s);
  const out: string[] = [];
  for (const c of cmds) {
    switch (c[0]) {
      case "M":
        out.push(`M${px(c[1])},${py(c[2])}`);
        break;
      case "L":
        out.push(`L${px(c[1])},${py(c[2])}`);
        break;
      case "C":
        out.push(
          `C${px(c[1])},${py(c[2])} ${px(c[3])},${py(c[4])} ${px(c[5])},${py(c[6])}`
        );
        break;
      case "Z":
        out.push("Z");
        break;
    }
  }
  return out.join(" ");
}

/**
 * The whole glyph as data, or null when the node carries no stamp, can't carry
 * one, or is too small to draw.
 *
 * Scene-space and rotation-free, like `polygonOutline` and `measureGeometry`:
 * the node's own rotation/flip transform is applied by each renderer around the
 * whole node, so there is nothing here for the two to disagree about.
 */
export function stampGeometry(node: SceneNode): StampGeometry | null {
  const spec = stampOf(node);
  if (!spec) return null;
  const box = stampBox(node);
  if (box.width < MIN_STAMP_SIDE) return null;
  return geometryIn(defOf(spec.kind), box);
}

/**
 * One icon drawn into a `size`×`size` box at the origin — what the panel's
 * picker renders.
 *
 * Deliberately the *same* emitter the canvas uses rather than a hand-drawn
 * thumbnail: the swatch a user picks from is then the mark they get, and adding
 * an icon to {@link STAMPS} needs no second drawing kept in step with the first.
 */
export function stampPreview(kind: StampKind, size: number): StampGeometry {
  return geometryIn(defOf(kind), { x: 0, y: 0, width: size, height: size });
}

function geometryIn(def: StampDef, box: Rect): StampGeometry {
  return {
    fillD: emit(def.fill, box),
    strokeD: emit(def.stroke, box),
    weight: (def.weight / STAMP_GRID) * box.width,
    box,
  };
}

/**
 * Stroke width that draws a halo of `width` scene px around the ink polyline
 * (`strokeD`): the ink's own weight plus `width` on each side, painted
 * underneath so only the surplus shows.
 */
export function stampHaloWeight(geo: StampGeometry, width: number): number {
  return geo.weight + width * 2;
}

/**
 * The same halo around the filled sub-paths (`fillD`), which have no weight of
 * their own — a centered stroke of twice the halo is half swallowed by the fill
 * painted over it, leaving exactly `width` outside.
 */
export function stampOutlineWeight(width: number): number {
  return width * 2;
}
