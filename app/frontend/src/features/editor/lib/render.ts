/**
 * Flatten a scene (or a single node subtree) to an image data URI via
 * Canvas2D — PNG, JPEG or WebP. Used by Save (whole page) and the Export
 * panel (one node). The SVG canvas is the interactive renderer; this is the
 * pixel-accurate export path, so the two must stay visually consistent —
 * keep shape/stroke/text logic in sync.
 */

import {
  calloutOutline,
  pathScenePoints,
  polygonOutline,
  rotatePoint,
  rotatedAABB,
  starOutline,
} from "../geometry";
import {
  hasCornerRadius,
  isContainer,
  lineEndpoints,
  type ArrowNode,
  type Corners,
  type Effect,
  type LineNode,
  type Paint,
  type PathNode,
  type Rect,
  type SceneNode,
  type TextNode,
} from "../types";
import {
  chromeBarRect,
  chromeControls,
  chromeDots,
  chromeOf,
  chromeSeparator,
  chromeTitle,
  chromeWindowRadii,
  chromeWindowRect,
} from "./chrome";
import { gradientGeometry, imageFill, rgba, topStroke } from "./paint";
import { renderFreeform } from "./freeform";
import { renderMesh } from "./mesh";
import { drawImageFill } from "./imageFill";
import { measureBounds, measureGeometry } from "./measure";
import { drawCover, findBaseImage, pixelateRegion } from "./sample";
import { spotlightScrim } from "./spotlight";
import {
  stampGeometry,
  stampHaloWeight,
  stampOf,
  stampOutlineWeight,
} from "./stamps";

const DEG = Math.PI / 180;

/** Encodings `canvas.toDataURL` can produce. PNG keeps alpha; the two
 *  lossy formats take a quality factor. */
export type ExportFormat = "png" | "jpeg" | "webp";

/** Canvas MIME type for an export format. */
export function formatMime(format: ExportFormat): string {
  return `image/${format}`;
}

/** Does this format drop the alpha channel? JPEG has none, so a scene
 *  with transparent areas has to be matted onto a background first —
 *  otherwise the encoder fills them with black. */
export function formatIsOpaque(format: ExportFormat): boolean {
  return format === "jpeg";
}

/** Matte painted under opaque-format exports (see `formatIsOpaque`). */
const OPAQUE_MATTE = "#ffffff";

/** Matches the browser's own `toDataURL` default for lossy encoders. */
const DEFAULT_QUALITY = 0.92;

export interface FlattenOptions {
  /** Output pixel multiplier (1x, 2x, …). */
  scale?: number;
  /** Export just this node's subtree instead of every root. */
  nodeId?: string | null;
  /** Encoding for the returned data URI. Defaults to `"png"`. */
  format?: ExportFormat;
  /** Lossy-encoder quality, 0–1. Ignored for PNG. Defaults to 0.92 —
   *  the browser's own `toDataURL` default. */
  quality?: number;
}

export async function flattenScene(
  nodes: Record<string, SceneNode>,
  rootIds: readonly string[],
  options: FlattenOptions = {}
): Promise<string> {
  const scale = options.scale ?? 1;
  const targetIds = options.nodeId ? [options.nodeId] : rootIds;
  const targets = targetIds
    .map((id) => nodes[id])
    .filter((n): n is SceneNode => !!n);

  const region = unionExportBounds(targets);
  const rect: Rect = region ?? { x: 0, y: 0, width: 1, height: 1 };

  const images = await loadImages(collectSources(nodes, targetIds));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  const format = options.format ?? "png";
  // Matte before any transform so it covers the whole output bitmap.
  if (formatIsOpaque(format)) {
    ctx.fillStyle = OPAQUE_MATTE;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.scale(scale, scale);
  ctx.translate(-rect.x, -rect.y);
  for (const node of targets) drawNode(ctx, nodes, node, images, 1);

  // A browser that can't encode the requested format silently returns
  // PNG. That's a fine degradation — the data URI still declares what it
  // actually is, and the backend derives the extension from that.
  return canvas.toDataURL(
    formatMime(format),
    options.quality ?? DEFAULT_QUALITY
  );
}

// ---------- export region ----------

/**
 * The region one node's export has to cover: its rotated AABB, grown to include
 * anything the node draws *outside* its own frame.
 *
 * `rotatedAABB` measures a node's *frame*, and two features paint past it: a
 * chromed node draws a title bar **above** it (`lib/chrome.ts`), and a
 * dimension line hangs its caps and label pill off a segment whose frame is
 * often zero-height (`lib/measure.ts`). Exporting either on its own would
 * otherwise slice the decoration off. Deliberately not folded into
 * `rotatedAABB` itself: that function also backs selection chrome, hit-testing
 * and zoom-to-selection, where the node's own box is the right answer and the
 * decoration is something that follows it (ADR 0022).
 *
 * The window's corners rotate about the **node's** centre, not the window's,
 * because that is the transform both renderers apply to the whole group. A
 * dimension needs no such correction: line-like nodes always have
 * `rotation === 0`.
 */
export function exportBounds(node: SceneNode): Rect {
  const marks = measureBounds(node);
  if (marks) return marks;
  if (!chromeOf(node)) return rotatedAABB(node);
  const win = chromeWindowRect(node);
  const centre = {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
  const corners = [
    { x: win.x, y: win.y },
    { x: win.x + win.width, y: win.y },
    { x: win.x + win.width, y: win.y + win.height },
    { x: win.x, y: win.y + win.height },
  ].map((p) => rotatePoint(p, centre, node.rotation));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/** Union of {@link exportBounds} over the export's targets — the whole-page
 *  path's `unionBounds`, corrected the same way. Null when there is nothing to
 *  draw. */
function unionExportBounds(nodes: readonly SceneNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const b = exportBounds(node);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ---------- image preloading ----------

function collectSources(
  nodes: Record<string, SceneNode>,
  ids: readonly string[]
): string[] {
  const srcs = new Set<string>();
  let hasSample = false;
  const visit = (id: string) => {
    const node = nodes[id];
    if (!node) return;
    const img = imageFill(node.fills);
    if (img?.src) srcs.add(img.src);
    if (node.sample) hasSample = true;
    if (isContainer(node)) node.children.forEach(visit);
  };
  ids.forEach(visit);
  // Sample regions (blur/magnifier) draw the base image, which may not appear
  // in the exported subtree — make sure it's loaded.
  if (hasSample) {
    const base = findBaseImage(nodes);
    if (base) srcs.add(base.src);
  }
  return [...srcs];
}

type LoadedImage = [string, HTMLImageElement] | null;

function loadOne(src: string): Promise<LoadedImage> {
  const { promise, resolve } = Promise.withResolvers<LoadedImage>();
  const img = new Image();
  img.onload = () => resolve([src, img]);
  img.onerror = () => resolve(null);
  img.src = src;
  return promise;
}

async function loadImages(
  srcs: string[]
): Promise<Map<string, HTMLImageElement>> {
  const entries = await Promise.all(srcs.map(loadOne));
  const map = new Map<string, HTMLImageElement>();
  for (const e of entries) if (e) map.set(e[0], e[1]);
  return map;
}

// ---------- node drawing ----------

function drawNode(
  ctx: CanvasRenderingContext2D,
  nodes: Record<string, SceneNode>,
  node: SceneNode,
  images: Map<string, HTMLImageElement>,
  parentAlpha: number
): void {
  if (!node.visible || node.opacity <= 0) return;
  const alpha = parentAlpha * node.opacity;

  ctx.save();
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  if (node.rotation !== 0) {
    ctx.translate(cx, cy);
    ctx.rotate(node.rotation * DEG);
    ctx.translate(-cx, -cy);
  }
  if (node.flipH || node.flipV) {
    ctx.translate(cx, cy);
    ctx.scale(node.flipH ? -1 : 1, node.flipV ? -1 : 1);
    ctx.translate(-cx, -cy);
  }
  ctx.globalAlpha = alpha;
  if (node.blendMode && node.blendMode !== "normal") {
    ctx.globalCompositeOperation = node.blendMode;
  }

  const blur = node.effects.find((e) => e.visible && e.type === "layer-blur");
  if (blur) ctx.filter = `blur(${blur.blur}px)`;

  switch (node.type) {
    case "line":
    case "arrow":
      drawLine(ctx, node, alpha);
      break;
    case "path":
      drawPath(ctx, nodes, node, images, alpha);
      break;
    case "text":
      drawText(ctx, node, alpha);
      break;
    default:
      drawShape(ctx, nodes, node, images, alpha);
  }

  ctx.filter = "none";

  if (isContainer(node)) {
    ctx.save();
    if (node.clipContent) {
      shapePath(ctx, node);
      ctx.clip();
    }
    for (const id of node.children) {
      const child = nodes[id];
      if (child) drawNode(ctx, nodes, child, images, alpha);
    }
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Paint a gradient fill, kept in lock-step with `SceneNodeView`'s `GradientFill`
 * (see G1). Linear is a plain endpoint gradient. Radial clips to the shape, then
 * stretches a unit-circle gradient to `rx`×`ry` (box-fit ellipse by default, an
 * equal-radius circle when `shape === "circle"`) — the transform is what makes
 * the export match the live SVG's objectBoundingBox radial.
 */
function paintGradientFill(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  fill: Paint,
  alpha: number
): void {
  const g = fill.gradient;
  if (!g) return;

  if (g.kind === "freeform" || g.kind === "mesh") {
    // Raster gradients (no native primitive) — render to a canvas and blit it.
    const canvas =
      g.kind === "mesh"
        ? renderMesh(g, node.width, node.height)
        : renderFreeform(g, node.width, node.height);
    if (!canvas) return;
    ctx.save();
    shapePath(ctx, node);
    ctx.clip();
    ctx.globalAlpha = alpha * fill.opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, node.x, node.y, node.width, node.height);
    ctx.restore();
    ctx.globalAlpha = alpha;
    return;
  }

  const geo = gradientGeometry(g);
  const stops = [...g.stops].sort((a, b) => a.position - b.position);
  const addStops = (grad: CanvasGradient) => {
    for (const s of stops) {
      grad.addColorStop(
        Math.max(0, Math.min(1, s.position)),
        rgba(s.color, s.opacity)
      );
    }
  };

  if (g.kind === "linear") {
    const grad = ctx.createLinearGradient(
      node.x + geo.start.x * node.width,
      node.y + geo.start.y * node.height,
      node.x + geo.end.x * node.width,
      node.y + geo.end.y * node.height
    );
    addStops(grad);
    ctx.globalAlpha = alpha * fill.opacity;
    ctx.fillStyle = grad;
    shapePath(ctx, node);
    ctx.fill();
    ctx.globalAlpha = alpha;
    return;
  }

  // Radial. A circle uses equal px radii (box-width fraction); an ellipse fits
  // the box. Matches `SceneNodeView`'s GradientFill and the G2 radius handle.
  const cx = node.x + geo.center.x * node.width;
  const cy = node.y + geo.center.y * node.height;
  const rx = geo.radius * node.width;
  const ry =
    geo.shape === "circle" ? geo.radius * node.width : geo.radius * node.height;
  if (rx <= 0 || ry <= 0) return;
  // Focal in the unit space the gradient is created in (before the scale).
  const fx = (node.x + geo.focal.x * node.width - cx) / rx;
  const fy = (node.y + geo.focal.y * node.height - cy) / ry;
  const grad = ctx.createRadialGradient(fx, fy, 0, 0, 0, 1);
  addStops(grad);
  ctx.save();
  shapePath(ctx, node);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.scale(rx, ry);
  ctx.globalAlpha = alpha * fill.opacity;
  ctx.fillStyle = grad;
  ctx.fillRect(-1e6, -1e6, 2e6, 2e6);
  ctx.restore();
  ctx.globalAlpha = alpha;
}

/**
 * Paint a stamp — the bundled glyph fit into the node's box. Draws nothing when
 * the box is too small to carry one, which is also what `StampMark` does; the
 * decision of *whether* a node is a stamp at all is `stampOf`'s, taken by both
 * renderers before they get here so they can't answer it differently.
 *
 * Both path strings come from `lib/stamps.ts` and are filled/stroked exactly as
 * `SceneNodeView`'s `StampMark` fills and strokes them, down to the paint order:
 * halo (the node's strokes, widened underneath) then ink (its solid fills), and
 * within each the areal sub-paths before the linear ones. Two spellings of one
 * drawing, sharing the path itself rather than the numbers (ADR 0023).
 */
function drawStamp(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  alpha: number
): void {
  const geo = stampGeometry(node);
  if (!geo) return;
  const area = geo.fillD ? new Path2D(geo.fillD) : null;
  const line = geo.strokeD ? new Path2D(geo.strokeD) : null;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of node.strokes) {
    if (!s.visible || s.width <= 0) continue;
    const paint = rgba(s.color, s.opacity);
    ctx.fillStyle = paint;
    ctx.strokeStyle = paint;
    if (area) {
      ctx.fill(area, "evenodd");
      ctx.lineWidth = stampOutlineWeight(s.width);
      ctx.stroke(area);
    }
    if (line) {
      ctx.lineWidth = stampHaloWeight(geo, s.width);
      ctx.stroke(line);
    }
  }
  for (const f of node.fills) {
    if (!f.visible || f.type !== "solid") continue;
    const paint = rgba(f.color, f.opacity);
    if (area) {
      ctx.fillStyle = paint;
      ctx.fill(area, "evenodd");
    }
    if (line) {
      ctx.strokeStyle = paint;
      ctx.lineWidth = geo.weight;
      ctx.stroke(line);
    }
  }
  ctx.restore();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  nodes: Record<string, SceneNode>,
  node: SceneNode,
  images: Map<string, HTMLImageElement>,
  alpha: number
): void {
  // A stamp replaces the box's own shape entirely (see `drawStamp`), before any
  // effect is considered — a shadow cast by the invisible rectangle behind the
  // glyph is not what either renderer should draw, and `SceneNodeView` skips its
  // filter wrapper for the same reason.
  if (stampOf(node)) {
    drawStamp(ctx, node, alpha);
    return;
  }

  const drop = node.effects.find((e) => e.visible && e.type === "drop-shadow");
  const inner = node.effects.find(
    (e) => e.visible && e.type === "inner-shadow"
  );

  // Drop shadow paints behind the fills (cast by the shape silhouette).
  if (drop) drawDropShadow(ctx, node, drop, alpha);

  // Blur/Magnifier regions re-sample the base image behind the fills, so a
  // translucent fill tints the sampled region (skipped when the sample's effect
  // is toggled off — see ADR 0015).
  if (node.sample && node.sample.enabled !== false) {
    drawSample(ctx, nodes, node, images, alpha);
  }

  // Spotlight: dim the whole page, punching this node's shape out of the scrim.
  // Painted here — over everything drawn earlier in z-order, before the fills —
  // so the hole reveals the content beneath. One even-odd `Path2D` from the
  // shared module, filled the same way SceneNodeView's `<path>` is (ADR 0023).
  const spot = spotlightScrim(node, nodes);
  if (spot) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgba(spot.color, spot.opacity);
    ctx.fill(new Path2D(spot.d), "evenodd");
    ctx.restore();
  }

  for (const fill of node.fills) {
    if (!fill.visible) continue;
    // Per-fill blend mode composites this fill with what's already painted.
    // Narrowing out "normal" leaves a value valid as a composite operation.
    const blend =
      fill.blendMode && fill.blendMode !== "normal" ? fill.blendMode : null;
    if (blend) {
      ctx.save();
      ctx.globalCompositeOperation = blend;
    }
    if (fill.type === "solid") {
      ctx.fillStyle = rgba(fill.color, fill.opacity);
      shapePath(ctx, node);
      ctx.fill();
    } else if (fill.type === "image" && fill.src) {
      const img = images.get(fill.src);
      if (img) {
        ctx.save();
        shapePath(ctx, node);
        ctx.clip();
        ctx.globalAlpha = alpha * fill.opacity;
        drawImageFill(
          ctx,
          img,
          node,
          fill.imageScale ?? "fill",
          fill.imageAlign ?? "center"
        );
        ctx.globalAlpha = alpha;
        ctx.restore();
      }
    } else if (fill.type === "gradient" && fill.gradient) {
      paintGradientFill(ctx, node, fill, alpha);
    }
    if (blend) ctx.restore();
  }

  // Window chrome paints after the fills — the bar sits outside the node's box,
  // directly above it — and before the strokes, which outline the whole window
  // and so must stay on top of the bar. Same order as `SceneNodeView`'s
  // `RectView`/`FrameView`.
  if (node.chrome) drawChrome(ctx, node, alpha);

  for (const stroke of node.strokes) {
    if (!stroke.visible || stroke.width <= 0) continue;
    ctx.save();
    ctx.strokeStyle = rgba(stroke.color, stroke.opacity);
    if (stroke.align === "center") {
      ctx.lineWidth = stroke.width;
      shapePath(ctx, node);
      ctx.stroke();
    } else {
      ctx.lineWidth = stroke.width * 2;
      shapePath(ctx, node);
      if (stroke.align === "inside") {
        ctx.clip();
      } else {
        // Outside: clip to the region outside the shape (even-odd with a
        // bounding rect) so only the outer half of the doubled stroke shows.
        ctx.beginPath();
        ctx.rect(node.x - 10000, node.y - 10000, 20000, 20000);
        shapePath(ctx, node, true);
        ctx.clip("evenodd");
      }
      shapePath(ctx, node);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Inner shadow paints on top of the fills, clipped to the shape.
  if (inner) drawInnerShadow(ctx, node, inner, alpha);

  // Step badge: the number sits on top of the fill.
  if (node.step) drawStepNumber(ctx, node, alpha);
}

// ---------- shadow effects (kept in sync with SceneNodeView; see ADR 0009) ----------

/** Large off-canvas displacement for the "shadow-only" trick: the caster is
 *  drawn this far off-screen and the shadow offset adds it back, so only the
 *  blurred shadow lands in view (never the opaque caster). */
const SHADOW_K = 100000;

/** A copy of `node` with its box grown by `spread` on every side (corner radii
 *  bumped to stay concentric). Drives drop-shadow spread on the export path —
 *  exact for box/ellipse, proportional for polygon/star (see ADR 0009). */
function spreadInflate(node: SceneNode, spread: number): SceneNode {
  if (spread === 0) return node;
  const grown = {
    ...node,
    x: node.x - spread,
    y: node.y - spread,
    width: Math.max(0.01, node.width + 2 * spread),
    height: Math.max(0.01, node.height + 2 * spread),
  } as SceneNode;
  if (hasCornerRadius(grown)) {
    grown.cornerRadius = Math.max(0, grown.cornerRadius + spread);
    if (grown.cornerRadii) {
      const c = grown.cornerRadii;
      grown.cornerRadii = {
        tl: Math.max(0, c.tl + spread),
        tr: Math.max(0, c.tr + spread),
        br: Math.max(0, c.br + spread),
        bl: Math.max(0, c.bl + spread),
      };
    }
  }
  return grown;
}

function drawDropShadow(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  fx: Effect,
  alpha: number
): void {
  ctx.save();
  ctx.shadowColor = rgba(fx.color, fx.opacity * alpha);
  ctx.shadowBlur = Math.max(0, fx.blur);
  ctx.shadowOffsetX = fx.offsetX + SHADOW_K;
  ctx.shadowOffsetY = fx.offsetY;
  ctx.fillStyle = "#000";
  ctx.translate(-SHADOW_K, 0);
  shapePath(ctx, spreadInflate(node, fx.spread));
  ctx.fill();
  ctx.restore();
}

function drawInnerShadow(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  fx: Effect,
  alpha: number
): void {
  ctx.save();
  // Clip to the shape; the caster (a big rect with the shape as an even-odd
  // hole) sits outside the clip, so only the shadow it casts inward shows.
  shapePath(ctx, node);
  ctx.clip();
  ctx.shadowColor = rgba(fx.color, fx.opacity * alpha);
  ctx.shadowBlur = Math.max(0, fx.blur);
  ctx.shadowOffsetX = fx.offsetX;
  ctx.shadowOffsetY = fx.offsetY;
  ctx.fillStyle = "#000";
  const m =
    Math.max(node.width, node.height) * 2 +
    Math.abs(fx.offsetX) +
    Math.abs(fx.offsetY) +
    fx.blur +
    100;
  ctx.beginPath();
  ctx.rect(node.x - m, node.y - m, node.width + 2 * m, node.height + 2 * m);
  shapePath(ctx, node, true);
  ctx.fill("evenodd");
  ctx.restore();
}

/** Append the node's outline to the current path (optionally without
 *  `beginPath`, for even-odd compositing). */
function shapePath(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  append = false
): void {
  if (!append) ctx.beginPath();
  const { x, y, width: w, height: h } = node;
  if (node.callout) {
    const pts = calloutOutline(node);
    pts.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
    );
    ctx.closePath();
    return;
  }
  if (node.type === "ellipse") {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (node.type === "polygon" || node.type === "star") {
    const pts =
      node.type === "polygon" ? polygonOutline(node) : starOutline(node);
    pts.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
    );
    ctx.closePath();
    return;
  }
  if (
    node.type === "frame" ||
    node.type === "rectangle" ||
    node.type === "image"
  ) {
    // With window chrome the outline is the whole window — bar + capture — so
    // the clip, strokes and the lift shadow treat the framed screenshot as one
    // object. Mirrors `SceneNodeView`'s `cornerPath`.
    roundedRectSubpath(ctx, chromeWindowRect(node), chromeWindowRadii(node));
    return;
  }
  if (node.type === "path") {
    const pts = pathScenePoints(node);
    pts.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
    );
    ctx.closePath();
    return;
  }
  ctx.rect(x, y, w, h);
}

/** Append a rounded rect to the current path, corner order matching
 *  `geometry.roundedRectPath` so the SVG and the export trace the same outline.
 *  Radii are assumed pre-clamped (see `cornerRadiiOf`). */
function roundedRectSubpath(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  radii: Corners
): void {
  const { x, y, width: w, height: h } = rect;
  const { tl, tr, br, bl } = radii;
  if (tl <= 0 && tr <= 0 && br <= 0 && bl <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr > 0) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  if (br > 0) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  if (bl > 0) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  if (tl > 0) ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/**
 * Paint the window title bar — background, buttons, title, hairline.
 *
 * Every number comes from `lib/chrome.ts`, so this and `SceneNodeView`'s
 * `ChromeBar` are two spellings of one drawing rather than two implementations
 * that have to be kept in agreement. The bar's background squares its *bottom*
 * corners because the window outline has already rounded its top.
 */
function drawChrome(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  alpha: number
): void {
  const spec = chromeOf(node);
  const bar = chromeBarRect(node);
  if (!spec || !bar) return;
  const radii = chromeWindowRadii(node);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  roundedRectSubpath(ctx, bar, {
    tl: radii.tl,
    tr: radii.tr,
    br: 0,
    bl: 0,
  });
  ctx.fillStyle = spec.color;
  ctx.fill();

  const line = chromeSeparator(node);
  if (line) {
    ctx.beginPath();
    ctx.moveTo(line.x1, line.y);
    ctx.lineTo(line.x2, line.y);
    ctx.strokeStyle = rgba(line.color, line.opacity);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (const dot of chromeDots(node)) {
    ctx.beginPath();
    ctx.arc(dot.cx, dot.cy, dot.r, 0, Math.PI * 2);
    ctx.fillStyle = dot.color;
    ctx.fill();
  }

  for (const control of chromeControls(node)) {
    ctx.strokeStyle = control.color;
    ctx.lineWidth = control.width;
    ctx.lineCap = "square";
    ctx.lineJoin = "miter";
    for (const points of control.strokes) {
      if (points.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i]!.x, points[i]!.y);
      }
      ctx.stroke();
    }
  }

  const title = chromeTitle(node);
  if (title) {
    ctx.fillStyle = title.color;
    ctx.font = `${title.weight} ${title.size}px "Inter", system-ui, sans-serif`;
    ctx.textAlign = title.align === "center" ? "center" : "left";
    ctx.textBaseline = "middle";
    ctx.letterSpacing = "0px";
    ctx.fillText(title.text, title.x, title.y);
  }
  ctx.restore();
}

/**
 * Paint a Blur/Magnifier "sample" region: the capture's base image, clipped to
 * the region shape and either blurred or zoomed about the region center. Drawn
 * the same way the normal image fill is (cover), so it aligns with the image
 * beneath. Mirrors `SceneNodeView`'s `SampledImage` — see ADR 0010.
 */
function drawSample(
  ctx: CanvasRenderingContext2D,
  nodes: Record<string, SceneNode>,
  node: SceneNode,
  images: Map<string, HTMLImageElement>,
  alpha: number
): void {
  const sample = node.sample;
  if (!sample) return;
  const base = findBaseImage(nodes);
  const img = base ? images.get(base.src) : undefined;
  if (!base || !img) return;
  ctx.save();
  shapePath(ctx, node);
  ctx.clip();
  ctx.globalAlpha = alpha;
  if (sample.mode === "magnify") {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const z = Math.max(1, sample.amount);
    ctx.translate(cx, cy);
    ctx.scale(z, z);
    ctx.translate(-cx, -cy);
    drawCover(ctx, img, base.rect);
  } else if (sample.mode === "pixelate") {
    // Region-sized mosaic, drawn within the shape clip at the node's local box.
    const out = pixelateRegion(img, base.rect, node, sample.amount);
    if (out) ctx.drawImage(out, node.x, node.y);
  } else {
    // blur
    ctx.filter = `blur(${Math.max(0, sample.amount)}px)`;
    drawCover(ctx, img, base.rect);
  }
  ctx.restore();
}

/**
 * Paint a dimension line — shaft (broken around the label), end caps, and the
 * length label pill. Returns false when the node carries no measurement, so
 * `drawLine` falls through to the plain shaft.
 *
 * Every number comes from `lib/measure.ts`; this and `SceneNodeView`'s
 * `MeasureMarks` are two spellings of one drawing. The label's rotate-about-the
 * -midpoint is the Canvas spelling of the SVG group's `rotate(deg cx cy)`.
 */
function drawMeasure(
  ctx: CanvasRenderingContext2D,
  node: LineNode | ArrowNode,
  alpha: number
): boolean {
  const geo = measureGeometry(node);
  if (!geo) return false;
  ctx.save();
  ctx.globalAlpha = alpha * geo.opacity;
  ctx.strokeStyle = geo.color;
  ctx.fillStyle = geo.color;
  ctx.lineWidth = geo.width;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  for (const [p, q] of [...geo.shaft, ...geo.ticks]) {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
    ctx.stroke();
  }
  for (const head of geo.heads) {
    if (head.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(head[0]!.x, head[0]!.y);
    for (let i = 1; i < head.length; i++) ctx.lineTo(head[i]!.x, head[i]!.y);
    ctx.closePath();
    ctx.fill();
  }

  const label = geo.label;
  ctx.translate(label.cx, label.cy);
  ctx.rotate(label.rotation * DEG);
  ctx.beginPath();
  roundedRectSubpath(
    ctx,
    {
      x: -label.width / 2,
      y: -label.height / 2,
      width: label.width,
      height: label.height,
    },
    {
      tl: label.radius,
      tr: label.radius,
      br: label.radius,
      bl: label.radius,
    }
  );
  ctx.fillStyle = label.plate;
  ctx.fill();
  ctx.fillStyle = label.color;
  ctx.font = `600 ${label.size}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.letterSpacing = "0px";
  ctx.fillText(label.text, 0, 0);
  ctx.restore();
  return true;
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  node: LineNode | ArrowNode,
  alpha: number
): void {
  // A dimension replaces the plain shaft entirely (see `drawMeasure`).
  if (drawMeasure(ctx, node, alpha)) return;
  const stroke = topStroke(node.strokes);
  if (!stroke) return;
  const { a, b } = lineEndpoints(node);
  ctx.strokeStyle = rgba(stroke.color, stroke.opacity * 1);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.globalAlpha = alpha;
  const isArrow = node.type === "arrow";
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const headLen = Math.max(8, stroke.width * 3.2);
  const spread = 0.5;
  // Stop the shaft at the arrowhead base so the round cap stays sharp.
  const baseDist = isArrow
    ? Math.min(headLen * Math.cos(spread), Math.hypot(b.x - a.x, b.y - a.y))
    : 0;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(
    b.x - baseDist * Math.cos(angle),
    b.y - baseDist * Math.sin(angle)
  );
  ctx.stroke();
  if (isArrow) {
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(
      b.x - headLen * Math.cos(angle - spread),
      b.y - headLen * Math.sin(angle - spread)
    );
    ctx.lineTo(
      b.x - headLen * Math.cos(angle + spread),
      b.y - headLen * Math.sin(angle + spread)
    );
    ctx.closePath();
    ctx.fill();
  }
}

function drawPath(
  ctx: CanvasRenderingContext2D,
  nodes: Record<string, SceneNode>,
  node: PathNode,
  images: Map<string, HTMLImageElement>,
  alpha: number
): void {
  const pts = pathScenePoints(node);
  if (pts.length < 2) return;
  ctx.globalAlpha = alpha;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    if (node.closed) ctx.closePath();
  };
  // A sample (blur/pixelate/magnify) paints behind the fills, clipped to the
  // path outline (implicitly closed) — `drawSample` clips via `shapePath`.
  if (node.sample && node.sample.enabled !== false) {
    drawSample(ctx, nodes, node, images, alpha);
  }
  if (node.closed) {
    for (const fill of node.fills) {
      if (!fill.visible || fill.type !== "solid") continue;
      trace();
      ctx.fillStyle = rgba(fill.color, fill.opacity);
      ctx.fill();
    }
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of node.strokes) {
    if (!stroke.visible || stroke.width <= 0) continue;
    trace();
    ctx.strokeStyle = rgba(stroke.color, stroke.opacity);
    ctx.lineWidth = stroke.width;
    ctx.stroke();
  }
}

function drawText(
  ctx: CanvasRenderingContext2D,
  node: TextNode,
  alpha: number
): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = rgba(node.color, 1);
  ctx.font = `${node.fontWeight} ${node.fontSize}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = "top";
  ctx.textAlign = node.align;
  ctx.letterSpacing = `${node.letterSpacing}px`;
  const lineH = node.fontSize * node.lineHeight;
  const anchorX =
    node.align === "center"
      ? node.x + node.width / 2
      : node.align === "right"
        ? node.x + node.width
        : node.x;
  node.text.split("\n").forEach((line, i) => {
    ctx.fillText(line, anchorX, node.y + i * lineH);
  });
}

/** Centered white number for a step badge — kept in sync with `EllipseView`'s
 *  SVG `<text>` (same size factor, weight, and baseline). */
function drawStepNumber(
  ctx: CanvasRenderingContext2D,
  node: SceneNode,
  alpha: number
): void {
  if (!node.step) return;
  const size = Math.min(node.width, node.height) * 0.6;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${size}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.letterSpacing = "0px";
  ctx.fillText(
    String(node.step.number),
    node.x + node.width / 2,
    node.y + node.height / 2
  );
  ctx.restore();
}
