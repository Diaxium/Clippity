/**
 * Crop model — pure geometry, no React, no store.
 *
 * This module owns the editor's **page** model, of which crop is the first
 * operation (device frames / backdrops are the next — Fork F4).
 *
 * **How crop is modelled.** A capture opens as one root *page frame* with the
 * bitmap as its child (`lib/seed.ts`), and both renderers take the document's
 * extent from the root nodes' union bounds. So cropping is *resizing the page
 * frame*: children keep their absolute scene coordinates and the frame's
 * `clipContent` does the trimming. That makes a crop
 *
 *   - **non-destructive** — no pixels are discarded, so undo (and re-cropping
 *     back outward) restores exactly what was there;
 *   - **one undo step** — a single doc transform, committed on Apply;
 *   - **format-agnostic** — nothing here touches the image data.
 *
 * The catch is that annotations don't all live *inside* the page (see
 * {@link absorbRootsIntoPage}), so committing folds the other roots in — that's
 * what makes the crop reach the exported image rather than just the screen.
 *
 * The same frame-rect model carries the other half of Fork F4: dragging a crop
 * edge *outward* past the bitmap already produces page padding, which is what
 * device frames / backdrop treatments will paint into.
 *
 * See ADR 0019 for the full rationale and the rejected alternatives.
 */

import type { ResizeHandle } from "../geometry";
import {
  isContainer,
  type Rect,
  type SceneDoc,
  type SceneNode,
  type Vec2,
} from "../types";

/** Smallest crop a drag may produce, in scene px. Small enough to crop a
 *  favicon out of a screenshot, large enough that the handles stay grabbable. */
export const MIN_CROP = 16;

/** Ratio comparisons are float math on user-dragged values — never `===`. */
const ASPECT_EPSILON = 1e-3;

/** A selectable aspect lock. `ratio` is width ÷ height; `null` is freeform.
 *  "Original" isn't listed here because its ratio depends on the document —
 *  the crop bar derives it from the session's starting rect. */
export interface CropAspect {
  label: string;
  ratio: number | null;
}

export const CROP_ASPECTS: readonly CropAspect[] = [
  { label: "Free", ratio: null },
  { label: "1:1", ratio: 1 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "9:16", ratio: 9 / 16 },
];

/**
 * The document's page frame — the node a crop resizes.
 *
 * It's the **backmost root**, and only when that root is a frame: that's what
 * `sceneFromImage` builds (the capture's clipping frame, with the bitmap
 * inside) and what a saved sidecar restores. Annotations may sit either inside
 * it (anything drawn over the image — see `editorStore.frameAt`) or as later
 * sibling roots (anything drawn past the edge, pasted, or ungrouped), but the
 * capture is always at the back.
 *
 * Requiring index 0 isn't fussiness — {@link absorbRootsIntoPage} relies on it
 * to preserve paint order. A document whose backmost root isn't a frame has no
 * well-defined page, so this returns `null` and the crop tool stays inert
 * rather than guessing at an extent.
 */
export function pageFrameId(
  rootIds: readonly string[],
  nodes: Record<string, SceneNode>
): string | null {
  const id = rootIds[0];
  if (!id) return null;
  const node = nodes[id];
  return node && isContainer(node) ? id : null;
}

/**
 * Fold every other root into the page frame, appended in their existing order.
 *
 * This is what makes a crop *mean* something. Both the export
 * (`render.flattenScene`) and zoom-to-fit take their extent from the union of
 * the **root** nodes, so as long as annotations sit beside the page rather than
 * inside it, shrinking the page alone would leave the exported image the same
 * size. Absorbing them makes the page the sole root, so the union collapses to
 * the crop rect and the frame's `clipContent` trims the overflow — the live SVG
 * canvas and the Canvas2D export then agree by construction, with no change to
 * either renderer.
 *
 * Paint order is preserved exactly: the page is the backmost root, so its own
 * children already painted before every stray, and appending the strays after
 * them keeps that sequence.
 */
export function absorbRootsIntoPage(doc: SceneDoc, pageId: string): SceneDoc {
  const strays = doc.rootIds.filter((id) => id !== pageId);
  if (strays.length === 0) return doc;
  const page = doc.nodes[pageId];
  if (!page || !isContainer(page)) return doc;
  return {
    rootIds: [pageId],
    nodes: {
      ...doc.nodes,
      [pageId]: { ...page, children: [...page.children, ...strays] },
    },
  };
}

/** A node's frame as a plain rect. */
export function rectOfNode(node: SceneNode): Rect {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

export function cropAspectRatio(rect: Rect): number {
  return rect.height > 0 ? rect.width / rect.height : 1;
}

export function sameAspect(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < ASPECT_EPSILON;
}

/** Slide the whole crop window. Crop never clamps to the image: dragging past
 *  the bitmap is how page padding is authored (see the module note). */
export function moveCrop(start: Rect, dx: number, dy: number): Rect {
  return { ...start, x: start.x + dx, y: start.y + dy };
}

/**
 * Resize a crop rect by dragging `handle` to `pointer`.
 *
 * A dragged edge never crosses its opposite — it clamps at {@link MIN_CROP}
 * instead of inverting, so the rect stays positive and the handles keep their
 * compass meaning through the whole drag. With `aspect` locked, a corner drag
 * follows whichever axis the pointer pushed further (so the crop tracks the
 * cursor rather than snapping to one master axis), while an edge drag grows the
 * *other* axis symmetrically about its centre.
 */
export function resizeCrop(
  start: Rect,
  handle: ResizeHandle,
  pointer: Vec2,
  aspect: number | null = null
): Rect {
  const movesW = handle.includes("w");
  const movesE = handle.includes("e");
  const movesN = handle.includes("n");
  const movesS = handle.includes("s");

  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (movesW) left = pointer.x;
  if (movesE) right = pointer.x;
  if (movesN) top = pointer.y;
  if (movesS) bottom = pointer.y;

  if (right - left < MIN_CROP) {
    if (movesW) left = right - MIN_CROP;
    else if (movesE) right = left + MIN_CROP;
  }
  if (bottom - top < MIN_CROP) {
    if (movesN) top = bottom - MIN_CROP;
    else if (movesS) bottom = top + MIN_CROP;
  }

  if (aspect === null || aspect <= 0) {
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  let w = right - left;
  let h = bottom - top;
  const corner = (movesW || movesE) && (movesN || movesS);
  if (corner) {
    if (w / aspect >= h) h = w / aspect;
    else w = h * aspect;
  } else if (movesW || movesE) {
    h = w / aspect;
  } else {
    w = h * aspect;
  }
  // Re-assert the minimum once the ratio is locked — the driven axis was
  // already clamped, but the derived one may have fallen under it.
  const grow = Math.max(1, MIN_CROP / w, MIN_CROP / h);
  w *= grow;
  h *= grow;

  // Grow away from the anchored edge; an axis the handle doesn't drive stays
  // centred on where it was.
  const x = movesW ? right - w : movesE ? left : left + (right - left - w) / 2;
  const y = movesN ? bottom - h : movesS ? top : top + (bottom - top - h) / 2;
  return { x, y, width: w, height: h };
}

/** Re-shape a rect to `ratio` about its centre, shrinking rather than growing
 *  so picking an aspect never pushes the crop outside what the user framed. */
export function applyCropAspect(rect: Rect, ratio: number): Rect {
  if (ratio <= 0) return rect;
  let w = rect.width;
  let h = w / ratio;
  if (h > rect.height) {
    h = rect.height;
    w = h * ratio;
  }
  const grow = Math.max(1, MIN_CROP / w, MIN_CROP / h);
  w *= grow;
  h *= grow;
  return {
    x: rect.x + (rect.width - w) / 2,
    y: rect.y + (rect.height - h) / 2,
    width: w,
    height: h,
  };
}

/** Snap a live crop rect to whole scene pixels for commit — a page frame with
 *  fractional bounds would land on half-pixel edges in the exported bitmap. */
export function roundCrop(rect: Rect): Rect {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  return {
    x,
    y,
    width: Math.max(MIN_CROP, Math.round(rect.x + rect.width) - x),
    height: Math.max(MIN_CROP, Math.round(rect.y + rect.height) - y),
  };
}

/** Does this rect differ from the node's current frame (post-rounding)? Guards
 *  the commit path so an opened-and-applied crop with no drag is not an edit. */
export function cropChanges(node: SceneNode, rect: Rect): boolean {
  return (
    node.x !== rect.x ||
    node.y !== rect.y ||
    node.width !== rect.width ||
    node.height !== rect.height
  );
}

/** Is a scene point inside the crop window (used to start a move drag)? */
export function pointInCrop(point: Vec2, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}
