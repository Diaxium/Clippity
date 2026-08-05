/**
 * Pure 2-D geometry for the editor canvas: rotation-aware hit-testing,
 * transform handles, and resize math. No React, no DOM — every export is a
 * deterministic function so the store and tests can exercise it directly.
 *
 * Convention: a node's frame is the unrotated rect `{ x, y, width, height }`
 * with `rotation` applied clockwise about the frame center. "Scene space" is
 * world px at zoom 1; "frame-local space" has its origin at the frame's
 * top-left with the rotation removed, so a hit lands inside the frame iff
 * `0 ≤ localX ≤ width && 0 ≤ localY ≤ height`.
 */

import {
  isLineLike,
  lineEndpoints,
  nodeBounds,
  type Corners,
  type PathNode,
  type PolygonNode,
  type Rect,
  type SceneNode,
  type StarNode,
  type Vec2,
} from "./types";

export const MIN_SIZE = 1;
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

/** Anchor (`fx`,`fy`) is the fixed point opposite the handle, as a fraction of
 *  the frame; `mx`/`my` flag whether the handle changes width / height. */
interface HandleSpec {
  fx: number;
  fy: number;
  mx: boolean;
  my: boolean;
}

const HANDLE_SPEC: Record<ResizeHandle, HandleSpec> = {
  nw: { fx: 1, fy: 1, mx: true, my: true },
  n: { fx: 0.5, fy: 1, mx: false, my: true },
  ne: { fx: 0, fy: 1, mx: true, my: true },
  e: { fx: 0, fy: 0.5, mx: true, my: false },
  se: { fx: 0, fy: 0, mx: true, my: true },
  s: { fx: 0.5, fy: 0, mx: false, my: true },
  sw: { fx: 1, fy: 0, mx: true, my: true },
  w: { fx: 1, fy: 0.5, mx: true, my: false },
};

const DEG = Math.PI / 180;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Rotate `p` by `deg` (clockwise, screen coords) about `center`. */
export function rotatePoint(p: Vec2, center: Vec2, deg: number): Vec2 {
  if (deg === 0) return { x: p.x, y: p.y };
  const rad = deg * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

function frameCenter(node: SceneNode): Vec2 {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/** Map a scene point into a box node's frame-local space (rotation removed,
 *  origin at the frame's top-left). */
export function sceneToFrameLocal(scene: Vec2, node: SceneNode): Vec2 {
  const center = frameCenter(node);
  const un = rotatePoint(scene, center, -node.rotation);
  return { x: un.x - node.x, y: un.y - node.y };
}

/** The four frame corners in scene space, rotation applied. Order: TL, TR, BR, BL. */
export function nodeCorners(node: SceneNode): [Vec2, Vec2, Vec2, Vec2] {
  const { x, y, width, height } = node;
  const center = frameCenter(node);
  const deg = node.rotation;
  return [
    rotatePoint({ x, y }, center, deg),
    rotatePoint({ x: x + width, y }, center, deg),
    rotatePoint({ x: x + width, y: y + height }, center, deg),
    rotatePoint({ x, y: y + height }, center, deg),
  ];
}

/** Axis-aligned bounding box of a node's rotated frame, in scene space. */
export function rotatedAABB(node: SceneNode): Rect {
  if (node.rotation === 0) return nodeBounds(node);
  const corners = nodeCorners(node);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Union AABB of several nodes (scene space). Returns null when empty. */
export function unionBounds(nodes: readonly SceneNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const b = rotatedAABB(node);
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/** Does `scene` land on `node`? `tolerance` is scene-space slack (for thin
 *  lines and zero-fill shapes the user still expects to be clickable). */
export function hitTestNode(
  node: SceneNode,
  scene: Vec2,
  tolerance = 0
): boolean {
  if (isLineLike(node)) {
    const { a, b } = lineEndpoints(node);
    const strokeW = node.strokes.reduce((m, s) => Math.max(m, s.width), 0);
    return pointSegmentDistance(scene, a, b) <= strokeW / 2 + tolerance + 2;
  }
  const local = sceneToFrameLocal(scene, node);
  const { width, height } = node;
  if (node.type === "ellipse") {
    const rx = width / 2;
    const ry = height / 2;
    if (rx <= 0 || ry <= 0) return false;
    const nx = (local.x - rx) / rx;
    const ny = (local.y - ry) / ry;
    return nx * nx + ny * ny <= 1;
  }
  if (node.type === "path") {
    if (node.points.length < 2) return false;
    const strokeW = node.strokes.reduce((m, s) => Math.max(m, s.width), 0);
    const slack = strokeW / 2 + tolerance + 2;
    const pts = node.points.map((p) => ({ x: p.x * width, y: p.y * height }));
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      best = Math.min(best, pointSegmentDistance(local, pts[i - 1]!, pts[i]!));
    }
    if (node.closed && pts.length > 2) {
      best = Math.min(
        best,
        pointSegmentDistance(local, pts[pts.length - 1]!, pts[0]!)
      );
    }
    return best <= slack;
  }
  return (
    local.x >= -tolerance &&
    local.x <= width + tolerance &&
    local.y >= -tolerance &&
    local.y <= height + tolerance
  );
}

/** Scene-space center of a resize handle on a node. */
export function handlePoint(node: SceneNode, handle: ResizeHandle): Vec2 {
  const spec = HANDLE_SPEC[handle];
  // The handle sits opposite its anchor: at fraction (1-fx, 1-fy) for the
  // moving axes, and at the midpoint for a fixed axis.
  const fracX = spec.mx ? 1 - spec.fx : 0.5;
  const fracY = spec.my ? 1 - spec.fy : 0.5;
  const center = frameCenter(node);
  return rotatePoint(
    { x: node.x + fracX * node.width, y: node.y + fracY * node.height },
    center,
    node.rotation
  );
}

/** Scene-space position of the rotation handle (above the top edge). */
export function rotationHandlePoint(node: SceneNode, offset: number): Vec2 {
  const center = frameCenter(node);
  return rotatePoint(
    { x: center.x, y: node.y - offset },
    center,
    node.rotation
  );
}

export interface ResizeOptions {
  /** Lock the aspect ratio of the original frame. */
  keepAspect?: boolean;
  /** Resize symmetrically about the frame center instead of the anchor. */
  fromCenter?: boolean;
}

/**
 * New frame after dragging `handle` to scene point `pointer`. The anchor
 * (the handle's opposite point) is held fixed in scene space, so the result
 * is correct at any rotation. Width/height are clamped to `MIN_SIZE` (no
 * flip). `rotation` is preserved on the returned frame implicitly — callers
 * keep the node's rotation; only `{x,y,width,height}` come from here.
 */
export function resizeFrame(
  start: Rect,
  rotation: number,
  handle: ResizeHandle,
  pointer: Vec2,
  options: ResizeOptions = {}
): Rect {
  const spec = HANDLE_SPEC[handle];
  const w0 = start.width;
  const h0 = start.height;
  const center0 = rectCenter(start);

  if (options.fromCenter) {
    // Symmetric resize: distance from center along frame axes sets the half-size.
    const rel = rotatePoint(sub(pointer, center0), { x: 0, y: 0 }, -rotation);
    let newW = spec.mx ? Math.max(MIN_SIZE, Math.abs(rel.x) * 2) : w0;
    let newH = spec.my ? Math.max(MIN_SIZE, Math.abs(rel.y) * 2) : h0;
    if (options.keepAspect && w0 > 0 && h0 > 0) {
      [newW, newH] = applyAspect(spec, w0, h0, newW, newH);
    }
    return {
      x: center0.x - newW / 2,
      y: center0.y - newH / 2,
      width: newW,
      height: newH,
    };
  }

  const anchorLocal = { x: spec.fx * w0, y: spec.fy * h0 };
  const anchorScene = rotatePoint(
    { x: start.x + anchorLocal.x, y: start.y + anchorLocal.y },
    center0,
    rotation
  );

  // Pointer expressed in the frame's (unrotated) axes, relative to the anchor.
  const rel = rotatePoint(sub(pointer, anchorScene), { x: 0, y: 0 }, -rotation);
  const dirX = spec.fx === 0 ? 1 : -1;
  const dirY = spec.fy === 0 ? 1 : -1;

  let newW = spec.mx ? Math.max(MIN_SIZE, rel.x * dirX) : w0;
  let newH = spec.my ? Math.max(MIN_SIZE, rel.y * dirY) : h0;
  if (options.keepAspect && w0 > 0 && h0 > 0) {
    [newW, newH] = applyAspect(spec, w0, h0, newW, newH);
  }

  // Reposition so the anchor keeps its scene point at the same rotation.
  const newCenter = sub(
    anchorScene,
    rotatePoint(
      { x: (spec.fx - 0.5) * newW, y: (spec.fy - 0.5) * newH },
      { x: 0, y: 0 },
      rotation
    )
  );
  return {
    x: newCenter.x - newW / 2,
    y: newCenter.y - newH / 2,
    width: newW,
    height: newH,
  };
}

function applyAspect(
  spec: HandleSpec,
  w0: number,
  h0: number,
  newW: number,
  newH: number
): [number, number] {
  const ratio = w0 / h0;
  if (spec.mx && spec.my) {
    // Corner: drive height from width.
    return [newW, newW / ratio];
  }
  if (spec.mx) return [newW, newW / ratio];
  return [newH * ratio, newH];
}

/** Angle (deg) of `pointer` relative to `center`, measured clockwise from the
 *  +Y (downward "north handle") direction so 0° matches an upright frame. */
export function angleFromCenter(center: Vec2, pointer: Vec2): number {
  return Math.atan2(pointer.x - center.x, -(pointer.y - center.y)) / DEG;
}

/** Normalize degrees into [0, 360). */
export function normalizeAngle(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/** Axis-aligned rectangle from two corner points (any order). */
export function normalizeRect(a: Vec2, b: Vec2): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/**
 * Draft rect for a draw gesture from anchor `start` to the current `pointer`.
 * `lineLike` keeps signed width/height (the rect encodes the a→b vector for
 * lines/arrows); otherwise the rect is normalized. When `constrain` (Shift is
 * held during creation) line-like drafts snap to 45° increments and box drafts
 * lock to a square that grows toward the pointer.
 */
export function drawRect(
  start: Vec2,
  pointer: Vec2,
  lineLike: boolean,
  constrain: boolean
): Rect {
  if (lineLike) {
    let dx = pointer.x - start.x;
    let dy = pointer.y - start.y;
    if (constrain) {
      const len = Math.hypot(dx, dy);
      const step = Math.PI / 4; // 45°
      const angle = Math.round(Math.atan2(dy, dx) / step) * step;
      dx = Math.cos(angle) * len;
      dy = Math.sin(angle) * len;
    }
    return { x: start.x, y: start.y, width: dx, height: dy };
  }
  if (constrain) {
    const dx = pointer.x - start.x;
    const dy = pointer.y - start.y;
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    return {
      x: dx < 0 ? start.x - size : start.x,
      y: dy < 0 ? start.y - size : start.y,
      width: size,
      height: size,
    };
  }
  return normalizeRect(start, pointer);
}

/** True when two axis-aligned rects overlap (touching edges don't count). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Vertices of a regular polygon inscribed in the node's (unrotated) box, in
 * scene space. First vertex points straight up. Node rotation is applied by the
 * renderer's transform, so these are rotation-free. Shared by the SVG view and
 * the canvas exporter so both draw the identical outline.
 */
export function polygonOutline(node: PolygonNode): Vec2[] {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const rx = node.width / 2;
  const ry = node.height / 2;
  const n = Math.max(3, Math.round(node.sides));
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

/**
 * Vertices of a star inscribed in the node's box: `pointCount` outer points
 * alternating with inner points at `innerRatio` of the radius. First outer
 * point straight up. Rotation-free, like {@link polygonOutline}.
 */
export function starOutline(node: StarNode): Vec2[] {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const rx = node.width / 2;
  const ry = node.height / 2;
  const n = Math.max(3, Math.round(node.pointCount));
  const inner = Math.min(0.95, Math.max(0.05, node.innerRatio));
  const out: Vec2[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const f = i % 2 === 0 ? 1 : inner;
    out.push({ x: cx + rx * f * Math.cos(a), y: cy + ry * f * Math.sin(a) });
  }
  return out;
}

type BoxEdge = "top" | "right" | "bottom" | "left";

/** Where a ray from the box center (unit direction `dx,dy`) exits the box, and
 *  on which edge. Anchors a callout tail's base to the body perimeter. */
function rayBoxExit(
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  x: number,
  y: number,
  w: number,
  h: number
): { pt: Vec2; edge: BoxEdge } {
  let best = Infinity;
  let pt: Vec2 = { x: cx + dx, y: cy + dy };
  let edge: BoxEdge = "bottom";
  const consider = (t: number, px: number, py: number, e: BoxEdge) => {
    const eps = 1e-6;
    if (
      t > 0 &&
      t < best &&
      px >= x - eps &&
      px <= x + w + eps &&
      py >= y - eps &&
      py <= y + h + eps
    ) {
      best = t;
      pt = { x: px, y: py };
      edge = e;
    }
  };
  if (dx !== 0) {
    consider((x - cx) / dx, x, cy + ((x - cx) / dx) * dy, "left");
    consider((x + w - cx) / dx, x + w, cy + ((x + w - cx) / dx) * dy, "right");
  }
  if (dy !== 0) {
    consider((y - cy) / dy, cx + ((y - cy) / dy) * dx, y, "top");
    consider((y + h - cy) / dy, cx + ((y + h - cy) / dy) * dx, y + h, "bottom");
  }
  return { pt, edge };
}

/**
 * The tail's base (where it leaves the body perimeter), its tip (`length` px
 * past that, in the aimed direction), and which edge it exits — rotation-free
 * scene coords like {@link calloutOutline}. Returns null for a node with no
 * callout. Shared by {@link calloutOutline} (which splices the base into the
 * outline), the on-canvas tail handle, and the drag→spec inverse
 * ({@link calloutTailFromLocal}), so all three agree on where the tip is.
 */
export function calloutTailGeometry(
  node: SceneNode
): { base: Vec2; tip: Vec2; edge: BoxEdge } | null {
  const c = node.callout;
  if (!c) return null;
  const { x, y, width: w, height: h } = node;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (c.angle * Math.PI) / 180;
  const dx = Math.sin(rad); // 0° = up, clockwise (matches angleFromCenter)
  const dy = -Math.cos(rad);
  const { pt: base, edge } = rayBoxExit(cx, cy, dx, dy, x, y, w, h);
  const tip = { x: base.x + dx * c.length, y: base.y + dy * c.length };
  return { base, tip, edge };
}

/**
 * Invert an on-canvas tail drag: given a pointer in the node's frame-local box
 * (origin at the top-left, rotation removed — exactly what
 * {@link sceneToFrameLocal} returns), the callout `{angle, length}` whose tip
 * lands under it. `angle` is measured like {@link angleFromCenter} (0 = up,
 * clockwise). `length` is the reach *past the body edge* along the aimed
 * direction, clamped to ≥ 0 so dragging the tip back inside the body collapses
 * the tail rather than flipping it through the center.
 */
export function calloutTailFromLocal(
  node: SceneNode,
  local: Vec2
): { angle: number; length: number } {
  const w = node.width;
  const h = node.height;
  const cx = w / 2;
  const cy = h / 2;
  const dx = local.x - cx;
  const dy = local.y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return { angle: node.callout?.angle ?? 0, length: 0 };
  const ux = dx / dist;
  const uy = dy / dist;
  const angle = normalizeAngle(angleFromCenter({ x: cx, y: cy }, local));
  const { pt: base } = rayBoxExit(cx, cy, ux, uy, 0, 0, w, h);
  const length = Math.max(0, (local.x - base.x) * ux + (local.y - base.y) * uy);
  return { angle, length };
}

/**
 * Integrated outline of a speech-bubble callout: the body rectangle with a
 * pointer tail spliced into one edge, as a single closed clockwise polygon
 * (sharp corners for now). The tail aims out from the body center at
 * `callout.angle` (0 = up, clockwise), tip `callout.length` px past the body
 * edge. Rotation-free / scene-space like {@link polygonOutline} — shared by the
 * SVG view and the canvas exporter, so fill and stroke flow around the tail.
 */
export function calloutOutline(node: SceneNode): Vec2[] {
  const { x, y, width: w, height: h } = node;
  const TL = { x, y };
  const TR = { x: x + w, y };
  const BR = { x: x + w, y: y + h };
  const BL = { x, y: y + h };
  const tail = calloutTailGeometry(node);
  if (!tail) return [TL, TR, BR, BL];

  const { base, tip, edge } = tail;
  const half = clamp(Math.min(w, h) * 0.16, 5, Math.min(w, h) / 2 - 1);

  if (edge === "top") {
    const bx = clamp(base.x, x + half, x + w - half);
    return [TL, { x: bx - half, y }, tip, { x: bx + half, y }, TR, BR, BL];
  }
  if (edge === "right") {
    const by = clamp(base.y, y + half, y + h - half);
    const r = x + w;
    return [
      TL,
      TR,
      { x: r, y: by - half },
      tip,
      { x: r, y: by + half },
      BR,
      BL,
    ];
  }
  if (edge === "bottom") {
    const bx = clamp(base.x, x + half, x + w - half);
    const b = y + h;
    return [
      TL,
      TR,
      BR,
      { x: bx + half, y: b },
      tip,
      { x: bx - half, y: b },
      BL,
    ];
  }
  const by = clamp(base.y, y + half, y + h - half); // left
  return [TL, TR, BR, BL, { x, y: by + half }, tip, { x, y: by - half }];
}

/** SVG path `d` (closed) for a {@link calloutOutline}. Shared by the SVG view. */
export function calloutSvgD(node: SceneNode): string {
  const pts = calloutOutline(node);
  if (pts.length === 0) return "";
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length; i++) d += ` L${pts[i]!.x},${pts[i]!.y}`;
  return d + " Z";
}

/**
 * SVG path `d` for a rectangle with independent corner radii (clockwise from
 * top-left). Shared by the SVG renderer; the canvas exporter mirrors the same
 * corner order so both stay visually identical. Radii are assumed pre-clamped
 * (see {@link cornerRadiiOf}).
 */
export function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: Corners
): string {
  const { tl, tr, br, bl } = r;
  return [
    `M${x + tl},${y}`,
    `H${x + w - tr}`,
    tr > 0 ? `A${tr},${tr} 0 0 1 ${x + w},${y + tr}` : "",
    `V${y + h - br}`,
    br > 0 ? `A${br},${br} 0 0 1 ${x + w - br},${y + h}` : "",
    `H${x + bl}`,
    bl > 0 ? `A${bl},${bl} 0 0 1 ${x},${y + h - bl}` : "",
    `V${y + tl}`,
    tl > 0 ? `A${tl},${tl} 0 0 1 ${x + tl},${y}` : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Path vertices in scene space (normalized points mapped into the node box). */
export function pathScenePoints(node: PathNode): Vec2[] {
  return node.points.map((p) => ({
    x: node.x + p.x * node.width,
    y: node.y + p.y * node.height,
  }));
}

/** SVG path `d` for a {@link PathNode} — a polyline through its points, closed
 *  when `node.closed`. Shared by the SVG renderer + canvas exporter. */
export function pathSvgD(node: PathNode): string {
  const pts = pathScenePoints(node);
  if (pts.length === 0) return "";
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length; i++) d += ` L${pts[i]!.x},${pts[i]!.y}`;
  if (node.closed) d += " Z";
  return d;
}
