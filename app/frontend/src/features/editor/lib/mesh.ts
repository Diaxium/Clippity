/**
 * Mesh-gradient raster engine (Workstream G4). A mesh is a `rows`×`cols` grid of
 * colored control points; every pixel is the **bilinear** interpolation of the
 * four surrounding cells. When points sit on the uniform grid this is a plain
 * grid blend; dragging a point warps its cells (G4b) — each pixel finds the cell
 * quad it lands in via inverse bilinear and interpolates that cell's corners.
 * Rasterized at a capped resolution and shown as an `<image>` (live) / redrawn
 * (export) — the same offscreen→image pattern as freeform (ADR 0013).
 */

import { meshSlotPoint, type GradientPaint, type MeshSpec } from "../types";
import { hexToRgb } from "./paint";
import { FREEFORM_CAP, type Rgba } from "./freeform";

/** Precompute each mesh cell as 0..255 rgba (avoids hex parsing per pixel). */
export function meshSources(mesh: MeshSpec): Rgba[] {
  return mesh.points.map((p) => {
    const { r, g, b } = hexToRgb(p.color);
    return { r, g, b, a: p.opacity * 255 };
  });
}

/** Bilinear color of the mesh at normalized (u, v) ∈ [0,1]². Degenerate single
 *  rows/columns interpolate only along the populated axis. */
export function meshColorAt(
  sources: readonly Rgba[],
  rows: number,
  cols: number,
  u: number,
  v: number
): Rgba {
  if (rows < 1 || cols < 1 || sources.length < rows * cols) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const lastI = cols - 1;
  const lastJ = rows - 1;
  const fx = u * lastI;
  const fy = v * lastJ;
  const i = lastI === 0 ? 0 : Math.min(lastI - 1, Math.max(0, Math.floor(fx)));
  const j = lastJ === 0 ? 0 : Math.min(lastJ - 1, Math.max(0, Math.floor(fy)));
  const tx = lastI === 0 ? 0 : fx - i;
  const ty = lastJ === 0 ? 0 : fy - j;
  const i2 = Math.min(lastI, i + 1);
  const j2 = Math.min(lastJ, j + 1);
  const p00 = sources[j * cols + i]!;
  const p10 = sources[j * cols + i2]!;
  const p01 = sources[j2 * cols + i]!;
  const p11 = sources[j2 * cols + i2]!;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const chan = (k: "r" | "g" | "b" | "a"): number =>
    lerp(lerp(p00[k], p10[k], tx), lerp(p01[k], p11[k], tx), ty);
  return { r: chan("r"), g: chan("g"), b: chan("b"), a: chan("a") };
}

/** A mesh control point resolved to box-space position + 0..255 rgba. */
export interface MeshNode {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Resolve a mesh to positioned nodes — each point's stored position, or its
 *  uniform-grid slot when absent (back-compat / freshly-resized). */
export function meshNodes(mesh: MeshSpec): MeshNode[] {
  const { rows, cols } = mesh;
  return mesh.points.map((p, idx) => {
    const j = Math.floor(idx / cols);
    const i = idx % cols;
    const pos = p.point ?? meshSlotPoint(rows, cols, j, i);
    const { r, g, b } = hexToRgb(p.color);
    return { x: pos.x, y: pos.y, r, g, b, a: p.opacity * 255 };
  });
}

const cross2 = (ax: number, ay: number, bx: number, by: number): number =>
  ax * by - ay * bx;
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Inverse bilinear: the parameters (u along the P00→P10 edge, v along P00→P01)
 * whose unit-square maps to box point (qx, qy) on the quad P00 P10 P01 P11.
 * Returns each real candidate (0, 1, or 2) — solved as a quadratic in v.
 */
function invBilinear(
  qx: number,
  qy: number,
  p00: MeshNode,
  p10: MeshNode,
  p01: MeshNode,
  p11: MeshNode
): { u: number; v: number }[] {
  const ex = p10.x - p00.x;
  const ey = p10.y - p00.y; // u edge
  const fx = p01.x - p00.x;
  const fy = p01.y - p00.y; // v edge
  const gx = p00.x - p10.x - p01.x + p11.x;
  const gy = p00.y - p10.y - p01.y + p11.y; // twist
  const hx = qx - p00.x;
  const hy = qy - p00.y;
  const k2 = cross2(gx, gy, fx, fy);
  const k1 = cross2(ex, ey, fx, fy) + cross2(hx, hy, gx, gy);
  const k0 = cross2(hx, hy, ex, ey);
  const vs: number[] = [];
  if (Math.abs(k2) < 1e-9) {
    if (Math.abs(k1) > 1e-12) vs.push(-k0 / k1);
  } else {
    const disc = k1 * k1 - 4 * k2 * k0;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      vs.push((-k1 - s) / (2 * k2), (-k1 + s) / (2 * k2));
    }
  }
  const out: { u: number; v: number }[] = [];
  for (const v of vs) {
    // Recover u from v; use whichever axis has the larger denominator.
    const denx = ex + gx * v;
    const deny = ey + gy * v;
    let u: number;
    if (Math.abs(denx) >= Math.abs(deny)) {
      if (Math.abs(denx) < 1e-12) continue;
      u = (hx - fx * v) / denx;
    } else {
      if (Math.abs(deny) < 1e-12) continue;
      u = (hy - fy * v) / deny;
    }
    out.push({ u, v });
  }
  return out;
}

function bilerpColor(
  n00: MeshNode,
  n10: MeshNode,
  n01: MeshNode,
  n11: MeshNode,
  u: number,
  v: number
): Rgba {
  const ch = (k: "r" | "g" | "b" | "a"): number =>
    lerp(lerp(n00[k], n10[k], u), lerp(n01[k], n11[k], u), v);
  return { r: ch("r"), g: ch("g"), b: ch("b"), a: ch("a") };
}

/**
 * Color of a warped mesh at box point (qx, qy) ∈ [0,1]². Finds the cell quad
 * that contains the point (inverse bilinear) and interpolates its four corners.
 * Points outside every cell — possible once nodes are dragged inward — clamp to
 * the nearest cell edge, so the fill never shows holes.
 */
export function meshColorAtWarped(
  nodes: readonly MeshNode[],
  rows: number,
  cols: number,
  qx: number,
  qy: number
): Rgba {
  if (rows < 2 || cols < 2 || nodes.length < rows * cols) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const EPS = 1e-4;
  let bestDist = Infinity;
  let bestColor: Rgba | null = null;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const n00 = nodes[j * cols + i]!;
      const n10 = nodes[j * cols + i + 1]!;
      const n01 = nodes[(j + 1) * cols + i]!;
      const n11 = nodes[(j + 1) * cols + i + 1]!;
      for (const { u, v } of invBilinear(qx, qy, n00, n10, n01, n11)) {
        const cu = u < 0 ? 0 : u > 1 ? 1 : u;
        const cv = v < 0 ? 0 : v > 1 ? 1 : v;
        if (u >= -EPS && u <= 1 + EPS && v >= -EPS && v <= 1 + EPS) {
          return bilerpColor(n00, n10, n01, n11, cu, cv);
        }
        // Outside this cell: keep the nearest clamped point as a fallback.
        const rx = lerp(lerp(n00.x, n10.x, cu), lerp(n01.x, n11.x, cu), cv);
        const ry = lerp(lerp(n00.y, n10.y, cu), lerp(n01.y, n11.y, cu), cv);
        const dist = (rx - qx) * (rx - qx) + (ry - qy) * (ry - qy);
        if (dist < bestDist) {
          bestDist = dist;
          bestColor = bilerpColor(n00, n10, n01, n11, cu, cv);
        }
      }
    }
  }
  if (bestColor) return bestColor;
  // No cell yielded a solution (a point fully outside a concave quad) — clamp to
  // the nearest node so the fill still has no holes.
  let nodeDist = Infinity;
  let nodeColor: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  for (const n of nodes) {
    const d = (n.x - qx) * (n.x - qx) + (n.y - qy) * (n.y - qy);
    if (d < nodeDist) {
      nodeDist = d;
      nodeColor = { r: n.r, g: n.g, b: n.b, a: n.a };
    }
  }
  return nodeColor;
}

/** Rasterize a mesh gradient to a capped-resolution canvas, or null when a 2D
 *  context is unavailable (e.g. jsdom) or there's no mesh. A ≥2×2 grid uses the
 *  warped sampler (honors dragged positions); degenerate 1×N grids — which have
 *  no quad cells — fall back to the uniform bilinear blend. */
export function renderMesh(
  gradient: GradientPaint,
  width: number,
  height: number
): HTMLCanvasElement | null {
  const mesh = gradient.mesh;
  if (!mesh || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, FREEFORM_CAP / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const warped = mesh.rows >= 2 && mesh.cols >= 2;
  const nodes = warped ? meshNodes(mesh) : [];
  const sources = warped ? [] : meshSources(mesh);
  if (!warped && sources.length === 0) return canvas;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const v = h === 1 ? 0 : y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = w === 1 ? 0 : x / (w - 1);
      const c = warped
        ? meshColorAtWarped(nodes, mesh.rows, mesh.cols, u, v)
        : meshColorAt(sources, mesh.rows, mesh.cols, u, v);
      const idx = (y * w + x) * 4;
      img.data[idx] = c.r;
      img.data[idx + 1] = c.g;
      img.data[idx + 2] = c.b;
      img.data[idx + 3] = c.a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
