/**
 * Page backdrop model — pure data transforms, no React, no store.
 *
 * The second half of Fork F4 ("crop + device frames — the *beautiful
 * screenshot* treatment"). {@link ./crop.ts} established the model this builds
 * on: **the seeded page frame *is* the page**, and cropping it *outward* past
 * the bitmap already produces padding. This module is what paints into that
 * padding, and gives it a number to type instead of a drag.
 *
 * Three ideas, all of them existing primitives rather than new ones:
 *
 * 1. **Padding is derived, never stored.** It's the gap between the page
 *    frame's rect and the capture's rect — exactly what an outward crop
 *    creates. Setting it re-derives the page rect from the capture
 *    ({@link paddedPageRect}); reading it measures the gap back
 *    ({@link pagePadding}). No new field means nothing to migrate in saved
 *    sidecars, nothing that can disagree with the rect, and crop and padding
 *    composing for free — they are the same edit.
 * 2. **The backdrop is the page frame's own `fills`.** Both renderers already
 *    paint a frame's fills beneath its children, so every fill type — solid,
 *    all four gradients, image — works as a backdrop with **no renderer
 *    change at all**. {@link BACKDROP_PRESETS} is just a menu of stock paints.
 * 3. **The content treatment is the capture node's `cornerRadius` + a
 *    drop-shadow `Effect`.** Also already rendered by both. The page frame
 *    clips its children, so the shadow is visible exactly when there's padding
 *    for it to fall into — which is the correct behaviour, for free.
 *
 * So the two-renderer parity invariant (the program's load-bearing constraint)
 * holds **by construction**: this module writes only fields both renderers
 * already read. See ADR 0020.
 */

import {
  makeSolidPaint,
  nextNodeId,
  type ChromeSpec,
  type Effect,
  type Paint,
  type Rect,
  type SceneDoc,
  type SceneNode,
} from "../types";
import { chromeWindowRect } from "./chrome";
import { absorbRootsIntoPage } from "./crop";
import { findBaseImage } from "./sample";

/** Largest padding the panel will author, in scene px. Generous enough for a
 *  social-card border, bounded so a mistyped value can't produce a 100k-px
 *  page that the export then tries to rasterize. */
export const MAX_PAGE_PADDING = 1000;

/** Default padding applied when a backdrop is picked on an unpadded page —
 *  without it the backdrop would be invisible (the capture covers the page
 *  exactly), which reads as "the preset did nothing". */
export const DEFAULT_PAGE_PADDING = 48;

/** Default corner radius applied to the capture alongside the first backdrop.
 *  Rounded corners are half of what makes the treatment read as "framed". */
export const DEFAULT_CONTENT_RADIUS = 12;

/**
 * The capture node the page pads around — the scene's base image.
 *
 * Deliberately the *same* helper both renderers use to resolve "which node is
 * the capture" for blur/magnifier sampling ({@link findBaseImage}), so the page
 * model can never disagree with them about what the document is a picture of.
 * Returns null for a document with no image (a blank scene), which is what
 * makes the Backdrop panel hide itself rather than pad nothing.
 *
 * The rect is the capture's **window** rect ({@link chromeWindowRect}), which
 * equals its own rect until window chrome is applied and then grows upward by
 * the title bar. Padding is measured and written against that one rect, so the
 * bar is inside the page rather than clipped by it — and so padding, crop and
 * chrome compose instead of fighting over the same edge.
 */
export function pageContent(
  nodes: Record<string, SceneNode>
): { id: string; rect: Rect } | null {
  const base = findBaseImage(nodes);
  if (!base) return null;
  const node = nodes[base.id];
  return { id: base.id, rect: node ? chromeWindowRect(node) : base.rect };
}

/**
 * Current uniform padding: the smallest of the four gaps between the page
 * frame's edges and the capture's, floored at 0.
 *
 * The minimum (rather than, say, the left gap) is what makes this robust after
 * an *asymmetric* edit — a crop that took more off one side leaves four
 * different gaps, and the smallest is the only one that is padding on every
 * side. Writing through {@link paddedPageRect} then re-normalizes all four to
 * the same value, so read-after-write is exact and the field converges instead
 * of drifting.
 */
export function pagePadding(page: SceneNode, content: Rect): number {
  const left = content.x - page.x;
  const top = content.y - page.y;
  const right = page.x + page.width - (content.x + content.width);
  const bottom = page.y + page.height - (content.y + content.height);
  return Math.max(0, Math.round(Math.min(left, top, right, bottom)));
}

/** The page rect that surrounds `content` with `padding` on all four sides.
 *  Whole pixels, for the same reason `roundCrop` rounds: a fractional page
 *  frame lands on half-pixel edges in the exported bitmap. */
export function paddedPageRect(content: Rect, padding: number): Rect {
  const p = Math.round(clampPadding(padding));
  return {
    x: Math.round(content.x) - p,
    y: Math.round(content.y) - p,
    width: Math.round(content.width) + 2 * p,
    height: Math.round(content.height) + 2 * p,
  };
}

export function clampPadding(padding: number): number {
  if (!Number.isFinite(padding)) return 0;
  return Math.max(0, Math.min(MAX_PAGE_PADDING, padding));
}

// ---------- backdrop presets ----------

/**
 * A stock backdrop. `build` returns **fresh** paints on every call because
 * paint ids are drawn from the global counter and must stay unique per
 * document — a shared frozen `Paint` would collide the moment two documents
 * (or an undo + re-apply) used the same preset.
 */
export interface BackdropPreset {
  id: string;
  label: string;
  /** CSS for the panel's swatch. Kept beside the paints so the swatch can
   *  never drift from what applying the preset actually paints. */
  swatch: string;
  build(): Paint[];
}

/** A two-stop linear gradient paint at `angle` degrees. */
function gradientPaint(from: string, to: string, angle: number): Paint {
  return {
    id: nextNodeId("fill"),
    type: "gradient",
    visible: true,
    opacity: 1,
    color: from,
    gradient: {
      kind: "linear",
      angle,
      stops: [
        { id: nextNodeId("stop"), position: 0, color: from, opacity: 1 },
        { id: nextNodeId("stop"), position: 1, color: to, opacity: 1 },
      ],
    },
  };
}

function solid(color: string): () => Paint[] {
  return () => [makeSolidPaint(color, 1)];
}

function linear(from: string, to: string, angle = 135): () => Paint[] {
  return () => [gradientPaint(from, to, angle)];
}

/**
 * The backdrop menu. "None" clears the fills back to a transparent page, which
 * is the state a freshly-opened capture is already in — so the presets are a
 * round trip, not a one-way door.
 *
 * The gradients deliberately avoid a mid-stop: two stops render identically in
 * SVG and Canvas2D with no interpolation subtleties, keeping the parity
 * guarantee trivially true.
 */
export const BACKDROP_PRESETS: readonly BackdropPreset[] = [
  {
    id: "none",
    label: "None",
    swatch: "transparent",
    build: () => [],
  },
  {
    id: "white",
    label: "White",
    swatch: "#ffffff",
    build: solid("#ffffff"),
  },
  {
    id: "slate",
    label: "Slate",
    swatch: "#1e232b",
    build: solid("#1e232b"),
  },
  {
    id: "violet",
    label: "Violet",
    swatch: "linear-gradient(135deg, #9747ff, #0d99ff)",
    build: linear("#9747ff", "#0d99ff"),
  },
  {
    id: "sunset",
    label: "Sunset",
    swatch: "linear-gradient(135deg, #ff8a3d, #ff5c93)",
    build: linear("#ff8a3d", "#ff5c93"),
  },
  {
    id: "mint",
    label: "Mint",
    swatch: "linear-gradient(135deg, #2bd9a8, #0d99ff)",
    build: linear("#2bd9a8", "#0d99ff"),
  },
  {
    id: "dusk",
    label: "Dusk",
    swatch: "linear-gradient(135deg, #2b3350, #0f1218)",
    build: linear("#2b3350", "#0f1218"),
  },
];

export function backdropPreset(id: string): BackdropPreset | null {
  return BACKDROP_PRESETS.find((p) => p.id === id) ?? null;
}

/**
 * Which preset the page currently shows, or null for a custom/edited backdrop.
 *
 * Matched on the painted colors rather than a stored preset id — the user can
 * open any backdrop in the color popover and tweak it, and the panel should
 * then honestly show "no preset selected" instead of keeping a stale highlight
 * on whichever one it started from.
 */
export function matchBackdropPreset(fills: readonly Paint[]): string | null {
  const key = fillsKey(fills);
  for (const preset of BACKDROP_PRESETS) {
    if (fillsKey(preset.build()) === key) return preset.id;
  }
  return null;
}

/** Identity of a fill stack for preset matching: everything that affects the
 *  painted result, and nothing that doesn't (ids, which differ every build). */
function fillsKey(fills: readonly Paint[]): string {
  return fills
    .filter((f) => f.visible)
    .map((f) => {
      const g = f.gradient;
      const stops = g?.stops.map(
        (s) => `${s.position}:${s.color}:${s.opacity}`
      );
      return [
        f.type,
        f.color.toLowerCase(),
        f.opacity,
        g?.kind ?? "",
        g?.angle ?? "",
        stops?.join(",") ?? "",
        f.src ?? "",
      ].join("|");
    })
    .join(";");
}

// ---------- content treatment ----------

/**
 * The capture's drop shadow — bigger, softer and lower-contrast than the
 * generic `makeShadow()` the Effects panel adds. A screenshot floating on a
 * backdrop needs a *lift*, which reads at a much larger blur than the crisp
 * UI-element shadow that default is tuned for.
 */
export function makeContentShadow(): Effect {
  return {
    id: nextNodeId("fx"),
    type: "drop-shadow",
    visible: true,
    color: "#000000",
    opacity: 0.35,
    offsetX: 0,
    offsetY: 18,
    blur: 45,
    spread: 0,
  };
}

export function hasContentShadow(node: SceneNode): boolean {
  return node.effects.some((e) => e.type === "drop-shadow" && e.visible);
}

// ---------- document transforms ----------

/** Replace a node in a doc, preserving its concrete type. Local mirror of the
 *  store's private `patchNode` so these transforms stay pure and testable. */
function patch(doc: SceneDoc, id: string, p: Partial<SceneNode>): SceneDoc {
  const node = doc.nodes[id];
  if (!node) return doc;
  return {
    rootIds: doc.rootIds,
    nodes: { ...doc.nodes, [id]: { ...node, ...p } as SceneNode },
  };
}

/**
 * ### Why these two transforms absorb the document's stray roots
 *
 * Both renderers size the output from `unionBounds` of the **root** nodes, and
 * annotations do not reliably live inside the page: `editorStore.frameAt` only
 * reparents a new node when its centre lands within a frame, so anything drawn
 * past the image edge, pasted, or ungrouped becomes a *sibling root* of the
 * page (ADR 0019).
 *
 * A stray sitting outside the padded page therefore stretches the export region
 * past the page frame — and since the backdrop is the page frame's *fill*, that
 * overhang exports as an **unpainted band** down the side of the image: a
 * gradient backdrop on three sides and raw transparency on the fourth. It is
 * invisible on canvas (the stray renders fine over nothing) and shows up only
 * in the saved file, which is the worst place to find it.
 *
 * Crop hit the identical trap and answers it identically, so both transforms
 * reuse {@link absorbRootsIntoPage} rather than growing a second mechanism.
 * Paint order survives because the page is the backmost root — its children
 * already painted before every stray, so appending the strays keeps the
 * sequence. Idempotent: once the page is the sole root, later tweaks change
 * nothing structurally.
 */

/**
 * Resize the page frame so the capture sits inside `padding` px of margin.
 *
 * This is the same edit crop makes — patching the page frame's rect — so the
 * two share undo behaviour, non-destructiveness, and the guarantee that the
 * export follows.
 *
 * `clipContent` is forced on for the reason `commitCrop` forces it: a
 * non-clipping page would show, on the live canvas, content that the export
 * region trims — the parity invariant again.
 */
export function setPagePadding(
  doc: SceneDoc,
  pageId: string,
  content: Rect,
  padding: number
): SceneDoc {
  return absorbRootsIntoPage(
    patch(doc, pageId, {
      ...paddedPageRect(content, padding),
      clipContent: true,
    }),
    pageId
  );
}

/**
 * Paint the page frame's backdrop.
 *
 * Only a *non-empty* backdrop seals the page: with no fill there is nothing to
 * leave a gap, and restructuring the layer tree on the way back to "None" would
 * be a surprising side effect of clearing a color.
 */
export function setPageBackdrop(
  doc: SceneDoc,
  pageId: string,
  fills: Paint[]
): SceneDoc {
  const next = patch(doc, pageId, { fills });
  return fills.length > 0 ? absorbRootsIntoPage(next, pageId) : next;
}

/**
 * Apply (or clear) the capture's window chrome, keeping the page's margin.
 *
 * The subtlety this exists for: the title bar grows the capture's window rect
 * upward, and the page frame **clips its children**. Writing the spec alone
 * would therefore hide the bar behind the page's own top edge on any document
 * with less padding than the bar is tall — the ADR 0019/0020 export-region trap
 * one more time, and again invisible until you look at the saved file.
 *
 * So the margin is measured against the *old* window, the spec is applied, and
 * the same margin is re-applied against the *new* one. A page with no padding
 * grows by exactly the bar; a page with 48px keeps 48px on all four sides.
 * Clearing chrome runs the identical path in reverse, so the page shrinks back
 * instead of leaving an unexplained band of backdrop above the capture.
 *
 * Re-using {@link setPagePadding} also inherits its sealing (`absorbRootsIntoPage`)
 * and its `clipContent` guarantee for free, which is why this isn't a bare patch.
 */
export function setWindowChrome(
  doc: SceneDoc,
  pageId: string,
  contentId: string,
  chrome: ChromeSpec | null
): SceneDoc {
  const content = doc.nodes[contentId];
  const page = doc.nodes[pageId];
  if (!content || !page) return doc;
  const padding = pagePadding(page, chromeWindowRect(content));
  const next = patch(doc, contentId, { chrome });
  const grown = next.nodes[contentId];
  if (!grown) return next;
  return setPagePadding(next, pageId, chromeWindowRect(grown), padding);
}

/** Round the capture's corners. */
export function setContentRadius(
  doc: SceneDoc,
  contentId: string,
  radius: number
): SceneDoc {
  const node = doc.nodes[contentId];
  if (!node) return doc;
  const max = Math.min(node.width, node.height) / 2;
  const r = Math.max(0, Math.min(max, Math.round(radius)));
  // Per-corner radii would silently win over the uniform value, so clear them:
  // the panel offers one number and must be what the canvas obeys.
  return patch(doc, contentId, { cornerRadius: r, cornerRadii: null });
}

/**
 * Toggle the capture's lift shadow.
 *
 * Off removes *every* visible drop shadow rather than only the one this added,
 * so the toggle's state and the canvas can't disagree after the user edits or
 * duplicates shadows in the Effects panel. Other effect types are untouched.
 */
export function setContentShadow(
  doc: SceneDoc,
  contentId: string,
  on: boolean
): SceneDoc {
  const node = doc.nodes[contentId];
  if (!node) return doc;
  if (!on) {
    return patch(doc, contentId, {
      effects: node.effects.filter((e) => e.type !== "drop-shadow"),
    });
  }
  if (hasContentShadow(node)) return doc;
  return patch(doc, contentId, {
    effects: [
      ...node.effects.filter((e) => e.type !== "drop-shadow"),
      makeContentShadow(),
    ],
  });
}
