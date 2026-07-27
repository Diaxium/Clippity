# 0014 — Editor mesh gradients (bilinear raster)

- **Status:** Accepted (implemented, Workstream G4 — first pass)
- **Date:** 2026-06-09
- **Area:** `app/frontend/src/features/editor` — both renderers
- **Builds on:** [0013 — freeform gradients (raster IDW engine)](0013-editor-freeform-gradients.md)

## Context

The gradient spec's last type is **mesh** — a grid of color points with smooth
blending, for precise multi-point control. Like freeform, it has **no native
primitive** in SVG or Canvas2D, so it must be rasterized. ADR 0013 set the
template (offscreen canvas → `<image>` live / `drawImage` export); mesh reuses it
and differs only in the **per-pixel interpolation**. Illustrator's mesh is a grid
of movable points with bicubic (Coons-patch) interpolation — full-featured but
heavy. The owner's standing decision is **pragmatic approximation first**.

## Decision

Implement a **uniform-grid, bilinear** mesh as the first pass.

- **Model:** `GradientKind` gains `"mesh"`; `GradientPaint.mesh?: MeshSpec` where
  `MeshSpec = { rows, cols, points: MeshPoint[] }` (row-major, `MeshPoint =
  { color, opacity }`). Positions are **implicit** (a regular `rows`×`cols`
  grid) — no movable points yet. `makeMesh()` seeds a 2×2 four-corner blend;
  `resizeMesh()` grows/shrinks the grid (clamped 1..8), keeping overlapping cells
  and extending new rows/cols from the nearest edge.
- **Engine** (`lib/mesh.ts`): `meshSources` precomputes each cell's rgba once
  (avoids per-pixel hex parsing); `meshColorAt` is the pure **bilinear** blend of
  the four surrounding cells; `renderMesh` fills an `ImageData` at the same capped
  resolution (`FREEFORM_CAP`) as freeform.
- **Renderers:** the live `RasterGradientImage` (a generalization of freeform's
  image component — now takes the render fn) and the Canvas2D `paintGradientFill`
  raster branch both handle `freeform` **and** `mesh` through one path.
- **Editing:** `FillPicker` gains a **Mesh** kind with a `MeshBody` — rows/columns
  steppers + a grid of color cells (click a cell → its `ColorPicker`, like the
  gradient stops).

## Consequences

- Reuses 0013's raster path wholesale — small, low-risk addition.
- **Not** Illustrator-grade: a uniform grid with bilinear interpolation gives a
  smooth multi-point blend but **no movable points and no bicubic smoothness**
  (the spec's "point handles" / "smoothness"). Those are the next refinements.
- Bilinear is exact at the cell corners and linear between — visibly faceted at
  very low grid counts with high-contrast colors; fine at 3×3+.
- Pixel output isn't unit-testable in jsdom (no canvas 2D); tests cover the pure
  `meshColorAt`/`meshSources`/`resizeMesh` and the panel — the rendered blend
  needs an in-app eyeball.

## Alternatives considered

- **Coons-patch / bicubic now** — the real Illustrator mesh; deferred as the
  refinement (bilinear ships the capability first).
- **Movable mesh points** (drag on canvas like freeform) — deferred; would reuse
  the G2/G3 handle infrastructure when added.
- **WebGL** — overkill for a pragmatic v1 (same reasoning as ADR 0013).
