/**
 * Color helpers shared by the SVG canvas and the Canvas2D export renderer.
 * Paints store an opaque `#rrggbb` plus a separate 0..1 opacity; rendering
 * combines them into an `rgba()` string.
 */

import type {
  GradientPaint,
  GradientShape,
  Paint,
  Stroke,
  Vec2,
} from "../types";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_SHORT = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

export function hexToRgb(hex: string): Rgb {
  const long = HEX_LONG.exec(hex);
  if (long) {
    return {
      r: parseInt(long[1]!, 16),
      g: parseInt(long[2]!, 16),
      b: parseInt(long[3]!, 16),
    };
  }
  const short = HEX_SHORT.exec(hex);
  if (short) {
    return {
      r: parseInt(short[1]! + short[1]!, 16),
      g: parseInt(short[2]! + short[2]!, 16),
      b: parseInt(short[3]! + short[3]!, 16),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

/** Normalize any accepted hex form to a `#rrggbb` string. */
export function normalizeHex(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Relative luminance (Rec. 709) of a hex color, 0..1. Unparseable input reads
 *  as black, which is also what {@link hexToRgb} returns for it. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Readable ink for a filled background — near-black on light backgrounds,
 * near-white on dark ones.
 *
 * Luminance rather than any single channel, so a mid-tone picks the side that
 * actually contrasts instead of whichever component happened to be large.
 * Shared by the window-chrome bar (`chromeInk`) and the measurement label pill,
 * which both have to stay legible over a user-chosen color.
 */
export function readableInk(hex: string): string {
  return relativeLuminance(hex) > 0.55 ? "#1c1d20" : "#eceef0";
}

/** The topmost visible solid fill as a CSS color, or null if none paints a
 *  solid (e.g. only image fills, or no fills). */
export function solidFillCss(fills: readonly Paint[]): string | null {
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i]!;
    if (f.visible && f.type === "solid") return rgba(f.color, f.opacity);
  }
  return null;
}

/** Topmost visible image paint, if any. */
export function imageFill(fills: readonly Paint[]): Paint | null {
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i]!;
    if (f.visible && f.type === "image" && f.src) return f;
  }
  return null;
}

/** Topmost visible stroke, if any. */
export function topStroke(strokes: readonly Stroke[]): Stroke | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i]!;
    if (s.visible && s.width > 0) return s;
  }
  return null;
}

export interface Hsv {
  /** Hue 0..360. */
  h: number;
  /** Saturation 0..1. */
  s: number;
  /** Value 0..1. */
  v: number;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s;
  const hh = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) [r, g] = [c, x];
  else if (hh < 2) [r, g] = [x, c];
  else if (hh < 3) [g, b] = [c, x];
  else if (hh < 4) [g, b] = [x, c];
  else if (hh < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToHsv(hex: string): Hsv {
  return rgbToHsv(hexToRgb(hex));
}

export function hsvToHex(hsv: Hsv): string {
  return rgbToHex(hsvToRgb(hsv));
}

/** Endpoints of a linear gradient in objectBoundingBox units (0..1), derived
 *  from `angle` (degrees clockwise from +x, screen y-down). Shared so the SVG
 *  and canvas renderers point the gradient the same way. */
export function gradientLine(angle: number): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
} {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad) / 2;
  const dy = Math.sin(rad) / 2;
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
}

export interface GradientGeometry {
  /** Linear endpoints, normalized 0..1 in the node box. */
  start: Vec2;
  end: Vec2;
  /** Radial center / focal, normalized 0..1; `radius` is a box fraction. */
  center: Vec2;
  radius: number;
  focal: Vec2;
  shape: GradientShape;
}

/**
 * Resolve a gradient's geometry to normalized (0..1 box-space) handles, filling
 * back-compat defaults: linear endpoints from `angle`, radial centered with a
 * box-fit ellipse. The single source both renderers use, so the live SVG and the
 * Canvas2D export agree (fixes the radial circle-vs-ellipse mismatch — see G1).
 */
export function gradientGeometry(g: GradientPaint): GradientGeometry {
  const line = gradientLine(g.angle);
  const center = g.center ?? { x: 0.5, y: 0.5 };
  return {
    start: g.start ?? { x: line.x1, y: line.y1 },
    end: g.end ?? { x: line.x2, y: line.y2 },
    center,
    radius: g.radius ?? 0.5,
    focal: g.focal ?? center,
    shape: g.shape ?? "ellipse",
  };
}

export type GradientHandle = "start" | "end" | "center" | "radius" | "focal";

/**
 * Apply an on-canvas gradient-handle drag (Workstream G2). Given the handle, the
 * gradient being edited, its geometry at the start of the drag, and the pointer
 * in normalized box space, return the patched gradient. Pure — the canvas and
 * the tests both use it. Dragging the center carries the focal along (keeps its
 * offset); the radius handle uses the local-x distance from the center.
 */
export function applyGradientHandle(
  which: GradientHandle,
  g: GradientPaint,
  geo: GradientGeometry,
  p: Vec2
): GradientPaint {
  switch (which) {
    case "start":
      return { ...g, start: p };
    case "end":
      return { ...g, end: p };
    case "focal":
      return { ...g, focal: p };
    case "center":
      return {
        ...g,
        center: p,
        focal: {
          x: geo.focal.x + (p.x - geo.center.x),
          y: geo.focal.y + (p.y - geo.center.y),
        },
      };
    case "radius":
      return { ...g, radius: Math.max(0.02, Math.abs(p.x - geo.center.x)) };
  }
}

/** Move a freeform color stop to `p` (normalized box space) — works for a point
 *  or a line stop (ids are unique across the gradient). Pure — the freeform
 *  on-canvas drag (Workstream G3). */
export function moveFreeformPoint(
  g: GradientPaint,
  pointId: string,
  p: Vec2
): GradientPaint {
  if ((g.points ?? []).some((pt) => pt.id === pointId)) {
    return {
      ...g,
      points: g.points!.map((pt) =>
        pt.id === pointId ? { ...pt, point: p } : pt
      ),
    };
  }
  return {
    ...g,
    lines: (g.lines ?? []).map((line) => ({
      ...line,
      stops: line.stops.map((s) => (s.id === pointId ? { ...s, point: p } : s)),
    })),
  };
}

/** Move a mesh lattice node (by grid index) to `p`, clamped to the box. Pure —
 *  the mesh on-canvas drag (Workstream G4b). */
export function moveMeshPoint(
  g: GradientPaint,
  index: number,
  p: Vec2
): GradientPaint {
  if (!g.mesh || index < 0 || index >= g.mesh.points.length) return g;
  const point = {
    x: Math.max(0, Math.min(1, p.x)),
    y: Math.max(0, Math.min(1, p.y)),
  };
  return {
    ...g,
    mesh: {
      ...g.mesh,
      points: g.mesh.points.map((mp, k) =>
        k === index ? { ...mp, point } : mp
      ),
    },
  };
}

/** CSS `linear-gradient`/`radial-gradient` for previews (swatch + editor bar). */
export function gradientCss(g: GradientPaint): string {
  if (g.kind === "mesh") {
    const pts = g.mesh?.points ?? [];
    if (pts.length === 0) return "transparent";
    return `linear-gradient(135deg, ${pts
      .map((p) => rgba(p.color, p.opacity))
      .join(", ")})`;
  }
  if (g.kind === "freeform") {
    const pts =
      g.freeformMode === "lines"
        ? (g.lines ?? []).flatMap((l) => l.stops)
        : (g.points ?? []);
    if (pts.length === 0) return "transparent";
    // Approximate the raster blend with layered radials for the small preview.
    return pts
      .map(
        (p) =>
          `radial-gradient(circle at ${Math.round(p.point.x * 100)}% ${Math.round(
            p.point.y * 100
          )}%, ${rgba(p.color, p.opacity)} 0%, transparent 60%)`
      )
      .join(", ");
  }
  const stops = [...g.stops]
    .sort((a, b) => a.position - b.position)
    .map((s) => `${rgba(s.color, s.opacity)} ${Math.round(s.position * 100)}%`)
    .join(", ");
  return g.kind === "radial"
    ? `radial-gradient(circle at 50% 50%, ${stops})`
    : `linear-gradient(${g.angle + 90}deg, ${stops})`;
}

/** CSS background value for a fill-row swatch (image handled separately). */
export function paintPreviewCss(paint: Paint): string {
  if (paint.type === "gradient" && paint.gradient)
    return gradientCss(paint.gradient);
  return rgba(paint.color, paint.type === "solid" ? paint.opacity : 1);
}
