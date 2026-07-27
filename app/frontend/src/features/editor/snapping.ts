/**
 * Alignment snapping for the editor canvas. Pure geometry, no React/store.
 *
 * During a move or resize gesture the canvas asks this module where the
 * selection's edges/centers line up with other objects (and the artboard
 * center). The result is a small position nudge (`dx`/`dy` for moves) plus a
 * set of {@link Guide} lines to draw. Everything is in scene space; the caller
 * supplies `zoom` only to keep the snap radius constant in *screen* pixels.
 *
 * The candidate lines are built once per gesture (targets are static while the
 * selection drags) and threaded back in, so a 60fps drag never rebuilds them.
 */

import { rotatedAABB } from "./geometry";
import { isContainer, type Rect, type SceneNode } from "./types";

/** Snap radius in screen pixels — the same feel regardless of zoom. */
export const SNAP_PX = 6;

/** A candidate alignment line contributed by one target object (or the
 *  artboard). `pos` is the coordinate on `axis`; `lo`/`hi` bound the line's
 *  extent on the cross axis so a drawn guide only spans the relevant region. */
export interface SnapLine {
  axis: "x" | "y";
  pos: number;
  lo: number;
  hi: number;
  kind: "edge" | "center" | "canvas";
}

/** A guide to render: a thin line at `pos` on `axis`, spanning `start`..`end`
 *  on the cross axis. `kind` lets the renderer style artboard-center guides
 *  differently (full-length) from object edge/center guides. */
export interface Guide {
  axis: "x" | "y";
  pos: number;
  start: number;
  end: number;
  kind: SnapLine["kind"];
}

/** Selection ids plus every descendant — the set excluded from snap targets so
 *  a frame never snaps to its own children (which travel with it). */
export function excludeSet(
  nodes: Record<string, SceneNode>,
  ids: readonly string[]
): Set<string> {
  const out = new Set<string>();
  const visit = (id: string): void => {
    if (out.has(id)) return;
    const node = nodes[id];
    if (!node) return;
    out.add(id);
    if (isContainer(node)) for (const child of node.children) visit(child);
  };
  for (const id of ids) visit(id);
  return out;
}

/** Three alignment lines per axis (near edge, center, far edge) for one rect. */
function pushRectLines(out: SnapLine[], b: Rect): void {
  const right = b.x + b.width;
  const bottom = b.y + b.height;
  out.push(
    { axis: "x", pos: b.x, lo: b.y, hi: bottom, kind: "edge" },
    { axis: "x", pos: b.x + b.width / 2, lo: b.y, hi: bottom, kind: "center" },
    { axis: "x", pos: right, lo: b.y, hi: bottom, kind: "edge" },
    { axis: "y", pos: b.y, lo: b.x, hi: right, kind: "edge" },
    { axis: "y", pos: b.y + b.height / 2, lo: b.x, hi: right, kind: "center" },
    { axis: "y", pos: bottom, lo: b.x, hi: right, kind: "edge" }
  );
}

/**
 * Build the candidate snap lines for a gesture: an edge/center triplet for
 * every visible, unlocked, non-excluded node, plus the artboard center cross
 * (when `canvasBounds` is given). Computed once per gesture.
 */
export function buildSnapLines(
  nodes: Record<string, SceneNode>,
  exclude: ReadonlySet<string>,
  canvasBounds: Rect | null
): SnapLine[] {
  const lines: SnapLine[] = [];
  for (const id in nodes) {
    if (exclude.has(id)) continue;
    const node = nodes[id]!;
    if (!node.visible || node.locked) continue;
    pushRectLines(lines, rotatedAABB(node));
  }
  if (canvasBounds && canvasBounds.width > 0 && canvasBounds.height > 0) {
    const cx = canvasBounds.x + canvasBounds.width / 2;
    const cy = canvasBounds.y + canvasBounds.height / 2;
    lines.push(
      {
        axis: "x",
        pos: cx,
        lo: canvasBounds.y,
        hi: canvasBounds.y + canvasBounds.height,
        kind: "canvas",
      },
      {
        axis: "y",
        pos: cy,
        lo: canvasBounds.x,
        hi: canvasBounds.x + canvasBounds.width,
        kind: "canvas",
      }
    );
  }
  return lines;
}

/** The three probe coordinates (near/center/far) of `rect` on one axis. */
function probes(rect: Rect, axis: "x" | "y"): [number, number, number] {
  return axis === "x"
    ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
    : [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
}

/** Best snap offset on one axis: the smallest shift that lands any probe on a
 *  line, within `threshold`. Returns 0 when nothing is close enough. */
function bestOffset(
  rect: Rect,
  lines: readonly SnapLine[],
  axis: "x" | "y",
  threshold: number
): number {
  const ps = probes(rect, axis);
  let best = 0;
  let bestDist = threshold + 1;
  for (const line of lines) {
    if (line.axis !== axis) continue;
    for (const p of ps) {
      const d = Math.abs(line.pos - p);
      if (d < bestDist) {
        bestDist = d;
        best = line.pos - p;
      }
    }
  }
  return bestDist <= threshold ? best : 0;
}

/** A guide spans the union of the aligned rect's extent and the line's extent
 *  on the cross axis, so it visibly connects the two objects. */
function guideFor(line: SnapLine, rect: Rect): Guide {
  const [rlo, rhi] =
    line.axis === "x"
      ? [rect.y, rect.y + rect.height]
      : [rect.x, rect.x + rect.width];
  return {
    axis: line.axis,
    pos: line.pos,
    start: Math.min(line.lo, rlo),
    end: Math.max(line.hi, rhi),
    kind: line.kind,
  };
}

/** Every line a settled rect actually sits on (within `EPS`), as guides. When
 *  a coordinate hosts several coincident lines, prefer one guide but keep the
 *  longest extent and the strongest kind (canvas > center > edge). */
const KIND_RANK: Record<SnapLine["kind"], number> = {
  canvas: 3,
  center: 2,
  edge: 1,
};

export function alignmentGuides(
  rect: Rect,
  lines: readonly SnapLine[],
  threshold: number
): Guide[] {
  const EPS = Math.min(0.5, threshold);
  const byKey = new Map<string, Guide>();
  for (const axis of ["x", "y"] as const) {
    const ps = probes(rect, axis);
    for (const line of lines) {
      if (line.axis !== axis) continue;
      if (!ps.some((p) => Math.abs(line.pos - p) <= EPS)) continue;
      const next = guideFor(line, rect);
      const key = `${axis}:${Math.round(line.pos * 100) / 100}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, next);
      } else {
        byKey.set(key, {
          axis,
          pos: prev.pos,
          start: Math.min(prev.start, next.start),
          end: Math.max(prev.end, next.end),
          kind:
            KIND_RANK[next.kind] > KIND_RANK[prev.kind] ? next.kind : prev.kind,
        });
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Snap a moving selection. `proposed` is the selection's AABB at the un-snapped
 * pointer position; the returned `dx`/`dy` nudge it onto the nearest alignment,
 * and `guides` mark every line it ends up touching.
 */
export function snapMove(
  proposed: Rect,
  lines: readonly SnapLine[],
  zoom: number
): { dx: number; dy: number; guides: Guide[] } {
  const threshold = SNAP_PX / zoom;
  const dx = bestOffset(proposed, lines, "x", threshold);
  const dy = bestOffset(proposed, lines, "y", threshold);
  const settled: Rect = {
    x: proposed.x + dx,
    y: proposed.y + dy,
    width: proposed.width,
    height: proposed.height,
  };
  return { dx, dy, guides: alignmentGuides(settled, lines, threshold) };
}

/** Snap a free point to nearby lines on each axis independently (used to snap
 *  the dragged handle during an axis-aligned resize). */
export function snapPoint(
  point: { x: number; y: number },
  lines: readonly SnapLine[],
  zoom: number
): { x: number; y: number } {
  const threshold = SNAP_PX / zoom;
  let x = point.x;
  let y = point.y;
  let dxBest = threshold + 1;
  let dyBest = threshold + 1;
  for (const line of lines) {
    const d = Math.abs(line.pos - (line.axis === "x" ? point.x : point.y));
    if (line.axis === "x") {
      if (d < dxBest) {
        dxBest = d;
        x = line.pos;
      }
    } else if (d < dyBest) {
      dyBest = d;
      y = line.pos;
    }
  }
  return {
    x: dxBest <= threshold ? x : point.x,
    y: dyBest <= threshold ? y : point.y,
  };
}
