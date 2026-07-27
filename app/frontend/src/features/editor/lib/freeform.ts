/**
 * Freeform-gradient raster engine (Workstream G3). Neither SVG nor Canvas2D has
 * a native freeform/diffusion gradient, so we rasterize one: each color point is
 * a source, and every pixel is an inverse-distance-weighted (IDW, power 2) blend
 * of the sources — a smooth, organic multi-point gradient. The bitmap is computed
 * at a capped resolution and upscaled (the blend is smooth, so low-res is fine),
 * shown as an `<image>` in the live SVG and redrawn on export — the same
 * "compute offscreen → image" pattern as the pixelate tool (A2.1). Pragmatic
 * approximation per the G3 decision; true diffusion is a later refinement.
 */

import type { FreeformLine, FreeformStop, GradientPaint } from "../types";
import { hexToRgb } from "./paint";

export interface FreeformSource {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  /** 0..255 */
  a: number;
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** IDW (power 2) blend of the sources at pixel (x, y). Pure — the core of the
 *  engine, and what the tests exercise (the canvas wrapper isn't testable in
 *  jsdom). A tiny epsilon keeps a pixel sitting exactly on a source finite. */
export function freeformColorAt(
  sources: readonly FreeformSource[],
  x: number,
  y: number
): Rgba {
  if (sources.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let wa = 0;
  let wsum = 0;
  for (const s of sources) {
    const dx = x - s.x;
    const dy = y - s.y;
    const w = 1 / (dx * dx + dy * dy + 1e-6);
    wr += w * s.r;
    wg += w * s.g;
    wb += w * s.b;
    wa += w * s.a;
    wsum += w;
  }
  return { r: wr / wsum, g: wg / wsum, b: wb / wsum, a: wa / wsum };
}

/** One freeform stop → a pixel-space source on a `w`×`h` grid. */
function stopToSource(s: FreeformStop, w: number, h: number): FreeformSource {
  const { r, g, b } = hexToRgb(s.color);
  return { x: s.point.x * w, y: s.point.y * h, r, g, b, a: s.opacity * 255 };
}

/** Map freeform points (normalized box) to pixel-space sources. */
export function freeformSources(
  points: readonly FreeformStop[],
  w: number,
  h: number
): FreeformSource[] {
  return points.map((p) => stopToSource(p, w, h));
}

/** Spacing (px) between samples along a freeform line — dense enough for a smooth
 *  ridge of color, sparse enough to keep the IDW source count reasonable. */
const LINE_SAMPLE_PX = 4;

/**
 * Sample freeform lines into IDW sources: walk each segment, interpolating
 * position + color linearly, emitting a source every ~`LINE_SAMPLE_PX`. Shared
 * endpoints aren't double-counted; the final endpoint is added once. This is how
 * a line feeds the *same* blend as points (see G3b).
 */
export function lineSources(
  lines: readonly FreeformLine[],
  w: number,
  h: number
): FreeformSource[] {
  const out: FreeformSource[] = [];
  for (const line of lines) {
    const stops = line.stops;
    if (stops.length === 0) continue;
    if (stops.length === 1) {
      out.push(stopToSource(stops[0]!, w, h));
      continue;
    }
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i]!;
      const b = stops[i + 1]!;
      const ax = a.point.x * w;
      const ay = a.point.y * h;
      const bx = b.point.x * w;
      const by = b.point.y * h;
      const ca = hexToRgb(a.color);
      const cb = hexToRgb(b.color);
      const n = Math.max(
        1,
        Math.min(64, Math.round(Math.hypot(bx - ax, by - ay) / LINE_SAMPLE_PX))
      );
      for (let s = 0; s < n; s++) {
        const t = s / n; // [0,1) — the shared endpoint is emitted by the next seg
        out.push({
          x: ax + (bx - ax) * t,
          y: ay + (by - ay) * t,
          r: ca.r + (cb.r - ca.r) * t,
          g: ca.g + (cb.g - ca.g) * t,
          b: ca.b + (cb.b - ca.b) * t,
          a: (a.opacity + (b.opacity - a.opacity) * t) * 255,
        });
      }
    }
    out.push(stopToSource(stops[stops.length - 1]!, w, h));
  }
  return out;
}

/** The IDW sources for a freeform gradient on a `w`×`h` grid, by sub-mode
 *  (`lines` samples the lines, otherwise the points). Pure — testable. */
export function freeformAllSources(
  g: GradientPaint,
  w: number,
  h: number
): FreeformSource[] {
  return (g.freeformMode ?? "points") === "lines"
    ? lineSources(g.lines ?? [], w, h)
    : freeformSources(g.points ?? [], w, h);
}

/** Longest side (px) of the computed bitmap — small because the blend is smooth
 *  and gets upscaled by the renderers. */
export const FREEFORM_CAP = 128;

/**
 * Rasterize a freeform gradient into a (capped-resolution) canvas, or null when
 * a 2D context is unavailable (e.g. jsdom) or the box is degenerate. Both
 * renderers call this, so the live view and the export match.
 */
export function renderFreeform(
  gradient: GradientPaint,
  width: number,
  height: number
): HTMLCanvasElement | null {
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(1, FREEFORM_CAP / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const sources = freeformAllSources(gradient, w, h);
  if (sources.length === 0) return canvas; // transparent
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = freeformColorAt(sources, x + 0.5, y + 0.5);
      const i = (y * w + x) * 4;
      img.data[i] = c.r;
      img.data[i + 1] = c.g;
      img.data[i + 2] = c.b;
      img.data[i + 3] = c.a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
