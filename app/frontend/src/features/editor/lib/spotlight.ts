/**
 * Spotlight model — the page-dim overlay with a punched-out clear region
 * (Fork A-F2). Pure geometry + presets, no React, no store.
 *
 * ### Why this needs its own module
 *
 * Every other annotation renders *inside its own frame*: a callout's tail, a
 * step badge's number, a blur's sampled pixels all stay within the node's box.
 * A spotlight is the exception — its whole point is to dim **everything else**,
 * so its effect reaches the full page. That is the same situation window chrome
 * was in (a bar *outside* the node), and the answer is the same one ADR 0022
 * reached: no primitive both renderers already read can express it, so this
 * module is the shared source of truth. It hands each renderer **one even-odd
 * path** ({@link spotlightScrim}) — the page rect with the node's shape
 * subtracted — and each only decides how to *fill* it (an SVG `<path>` vs a
 * Canvas2D `Path2D`). One path, two spellings, no way for the branches to drift.
 *
 * ### Why applying a spotlight seals the page
 *
 * The scrim covers the **page frame's rect** ({@link spotlightPageRect}), and
 * both renderers size the export from `unionBounds` of the *root* nodes. If a
 * stray annotation sits outside the page (annotations don't reliably live inside
 * it — see `lib/crop.ts`), the export region would stretch past the scrim and
 * that overhang would export as an **undimmed band** — invisible on canvas,
 * visible only in the saved file. It is the ADR 0019/0020 export-region trap for
 * a third feature, and the store answers it the same way: adding a spotlight
 * runs `absorbRootsIntoPage`, so the page rect *is* the document extent and the
 * scrim covers all of it. See ADR 0023.
 */

import {
  cornerRadiiOf,
  isContainer,
  type EllipseNode,
  type RectangleNode,
  type Rect,
  type SceneNode,
  type SpotlightSpec,
  DEFAULT_SPOTLIGHT_COLOR,
  DEFAULT_SPOTLIGHT_OPACITY,
} from "../types";
import { roundedRectPath } from "../geometry";
import { chromeWindowRect } from "./chrome";
import { findBaseImage } from "./sample";

/** A fresh scrim spec for a newly-drawn spotlight. Kept beside the tool's seed
 *  ({@link DEFAULT_SPOTLIGHT_COLOR}) so the two never disagree. */
export function makeSpotlight(): SpotlightSpec {
  return { color: DEFAULT_SPOTLIGHT_COLOR, opacity: DEFAULT_SPOTLIGHT_OPACITY };
}

export function clampSpotlightOpacity(opacity: number): number {
  if (!Number.isFinite(opacity)) return DEFAULT_SPOTLIGHT_OPACITY;
  return Math.max(0, Math.min(1, opacity));
}

/**
 * Whether this node can carry a spotlight: a rectangle or an ellipse.
 *
 * The two region shapes the annotate tools already draw (redact/blur are
 * rectangles, the magnifier is an ellipse), and the two whose hole
 * {@link spotlightHoleD} can express exactly. Other types return false so a
 * stray spec is inert rather than half-rendered — the guard `spotlightOf` reads.
 */
export function canCarrySpotlight(
  node: SceneNode
): node is RectangleNode | EllipseNode {
  return node.type === "rectangle" || node.type === "ellipse";
}

/** The node's spotlight spec, or null — including for types that can't carry
 *  one, so a stale spec left on some other shape is inert. */
export function spotlightOf(node: SceneNode): SpotlightSpec | null {
  const spec = node.spotlight;
  if (!spec || !canCarrySpotlight(node)) return null;
  return spec;
}

// ---------- page geometry ----------

/** The frame that directly contains `id`, or null. */
function parentFrameOf(
  nodes: Record<string, SceneNode>,
  id: string
): string | null {
  for (const nid of Object.keys(nodes)) {
    const n = nodes[nid];
    if (n && isContainer(n) && n.children.includes(id)) return nid;
  }
  return null;
}

/**
 * The rect the scrim dims: the page frame's rect.
 *
 * Resolved without `rootIds` (the renderers don't have them) by walking up from
 * the capture ({@link findBaseImage}, the same node the page model treats) to
 * its **outermost frame ancestor** — which, in a sealed document, is the page
 * frame. That rect is bar-inclusive when window chrome grew the page (`lib/page.ts`
 * measured the margin against `chromeWindowRect`), so a spotlight composes with
 * chrome for free.
 *
 * Falls back to the capture's own window rect when it has no frame ancestor (a
 * blank/degenerate document), and null when there's no capture at all — which is
 * what makes a spotlight inert rather than dimming nothing.
 */
export function spotlightPageRect(
  nodes: Record<string, SceneNode>
): Rect | null {
  const base = findBaseImage(nodes);
  if (!base) return null;
  let top: string | null = null;
  let cur = base.id;
  const seen = new Set<string>([cur]);
  for (;;) {
    const parent = parentFrameOf(nodes, cur);
    if (!parent || seen.has(parent)) break;
    top = parent;
    seen.add(parent);
    cur = parent;
  }
  const frame = top ? nodes[top] : null;
  if (frame && isContainer(frame)) {
    return {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
    };
  }
  const node = nodes[base.id];
  return node ? chromeWindowRect(node) : base.rect;
}

// ---------- scrim path ----------

/** SVG/Path2D subpath tracing a plain rect, clockwise. */
function rectSubpath(rect: Rect): string {
  const { x, y, width: w, height: h } = rect;
  return `M${x},${y} H${x + w} V${y + h} H${x} Z`;
}

/**
 * The spotlight's clear region as a path — the hole punched out of the scrim.
 *
 * An ellipse is traced as two exact half-arcs (matching the SVG `<ellipse>` and
 * Canvas `ctx.ellipse` the node itself draws); a rectangle reuses
 * {@link roundedRectPath}, the very function the rect node's outline comes from,
 * so the hole and the node's own shape can never diverge.
 */
export function spotlightHoleD(node: RectangleNode | EllipseNode): string {
  if (node.type === "ellipse") {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const rx = node.width / 2;
    const ry = node.height / 2;
    return (
      `M${cx - rx},${cy} ` +
      `A${rx},${ry} 0 1 0 ${cx + rx},${cy} ` +
      `A${rx},${ry} 0 1 0 ${cx - rx},${cy} Z`
    );
  }
  // The only other spotlight-capable type is a rectangle, which always carries
  // corner radii — so its outline is exactly the rect node's own `cornerPath`.
  return roundedRectPath(
    node.x,
    node.y,
    node.width,
    node.height,
    cornerRadiiOf(node)
  );
}

/** What both renderers need to paint a spotlight scrim. */
export interface SpotlightScrim {
  /** One even-odd path — the page rect with the node's shape subtracted. An SVG
   *  `<path fill-rule="evenodd">` and a Canvas `ctx.fill(new Path2D(d), "evenodd")`
   *  fill it identically. */
  d: string;
  /** `#rrggbb`. */
  color: string;
  /** 0..1. */
  opacity: number;
}

/**
 * The scrim for a spotlight node, or null when the node carries none, can't
 * carry one, or the document has no page to dim.
 *
 * The path concatenates the page rect and the node's hole; filled even-odd, the
 * hole reads clear and everything else in the page dims. Both are in scene
 * space, so under the node's own (identity, for an axis-aligned region)
 * transform the two renderers land the scrim in the same place.
 */
export function spotlightScrim(
  node: SceneNode,
  nodes: Record<string, SceneNode>
): SpotlightScrim | null {
  const spec = spotlightOf(node);
  // `spotlightOf` already implies this, but the explicit guard narrows `node`
  // to the two hole-capable shapes for `spotlightHoleD`.
  if (!spec || !canCarrySpotlight(node)) return null;
  const page = spotlightPageRect(nodes);
  if (!page) return null;
  return {
    d: `${rectSubpath(page)} ${spotlightHoleD(node)}`,
    color: spec.color,
    opacity: clampSpotlightOpacity(spec.opacity),
  };
}

// ---------- panel tints ----------

/**
 * The two scrim colors the panel offers — dark for the common light capture,
 * light for a dark one. A short list rather than a full picker: a spotlight's
 * only real variables are *how much* to dim (opacity) and *which way* (this),
 * and the dim is meant to disappear against the content, not be a design accent.
 */
export interface SpotlightTint {
  id: string;
  label: string;
  color: string;
}

export const SPOTLIGHT_TINTS: readonly SpotlightTint[] = [
  { id: "dark", label: "Dark", color: DEFAULT_SPOTLIGHT_COLOR },
  { id: "light", label: "Light", color: "#f5f7fa" },
];

/** Which tint a scrim color matches, or null for a custom one. */
export function matchSpotlightTint(color: string): string | null {
  const hit = SPOTLIGHT_TINTS.find(
    (t) => t.color.toLowerCase() === color.toLowerCase()
  );
  return hit ? hit.id : null;
}
