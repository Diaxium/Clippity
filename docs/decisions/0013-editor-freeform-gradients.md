# 0013 — Editor freeform gradients (raster IDW engine)

- **Status:** Accepted (implemented — G3a points + G3b lines)
- **Date:** 2026-06-09
- **Area:** `app/frontend/src/features/editor` — both renderers
- **Builds on:** [0012 — pixelate sample regions](0012-editor-pixelate-sample-regions.md) (the offscreen-canvas → image pattern)

## Context

The gradient spec asks for **freeform** gradients (Illustrator-style: colors
blend organically from points placed anywhere in the shape) and, later, **mesh**.
Unlike linear/radial (G1–G2), these have **no native primitive in either
renderer** — SVG2's `<meshgradient>` ships in no browser (incl. our WebView2),
and Canvas2D has nothing comparable. So a freeform gradient cannot be "another
`<linearGradient>`"; it must be **rasterized**. The owner chose a **pragmatic
approximation first** (good-enough now, refine later) over Illustrator-grade
diffusion.

## Decision

Rasterize freeform gradients with an **inverse-distance-weighted (IDW, power 2)**
blend, in a shared engine (`lib/freeform.ts`), and surface the bitmap through the
**same "compute offscreen → `<image>` (live) / `drawImage` (export)" pattern as
pixelate**.

- **Model:** `GradientKind` gains `"freeform"`; `GradientPaint.points?:
  FreeformStop[]` where `FreeformStop = { id, point: Vec2 (normalized box),
  color, opacity }`. The `stops` array is unused for freeform. Back-compat: the
  field is optional; switching a fill to freeform seeds `makeFreeformPoints()`.
- **Engine:** `freeformColorAt(sources, x, y)` is the pure IDW core (each pixel =
  Σ wᵢ·colorᵢ / Σ wᵢ, wᵢ = 1/(dᵢ²+ε)). `renderFreeform(points, w, h)` fills an
  `ImageData` on an offscreen canvas at a **capped resolution** (`FREEFORM_CAP =
  128` on the long side) and returns it (null when no 2D context / degenerate
  box). The blend is smooth, so the low-res bitmap upscales cleanly.
- **Renderers:** live SVG `FreeformImage` (`SceneNodeView`) computes the bitmap
  in a `useMemo`, `toDataURL()`s it, and draws it as an `<image>` clipped to the
  shape; the Canvas2D export (`paintGradientFill` in `render.ts`) clips and
  `drawImage`s the same canvas. One engine ⇒ live == export.
- **Editing:** `FillPicker` gains a **Freeform** kind with a point editor (swatch
  per point + add/remove + color). **Positions are dragged on the canvas**,
  reusing the G2 handle infrastructure — `SelectionOverlay` renders a `data-grad=
  "point"` dot per point (with `data-grad-id`), and `EditorCanvas`'s gradient
  gesture routes a point drag through the pure `moveFreeformPoint`.
- **Lines (G3b):** a `freeformMode: "points" | "lines"` sub-mode. A line is an
  editable polyline of stops (`FreeformLine`), **sampled into the same IDW
  sources** (`lineSources` walks each segment, interpolating position + colour) —
  so the engine, the renderers, the overlay (a polyline + a dot per stop), and
  the drag (`moveFreeformPoint` searches points *and* line stops) are all shared.
  v1 edits a single line; multiple lines is a small follow-up (the model is an
  array).

## Consequences

- Freeform is a **third rendering path** (raster), not a native paint. It always
  reflects the points, recomputed on edit. The capped resolution keeps live drag
  cheap; `toDataURL` per frame is acceptable at 128² (perf tuning is a G3c
  follow-up — e.g. lower res during drag, `OffscreenCanvas`).
- **Not** true diffusion — IDW gives soft overlapping blobs, close to but not
  identical to Illustrator's solver. Accepted per the "pragmatic" decision.
- Pixel output isn't unit-testable in jsdom (no canvas 2D); tests cover the pure
  IDW core, the point-move helper, the panel, and the overlay handles — the
  rendered blend needs an in-app eyeball.
- This sets the template for **mesh (G4)**: another raster kind through the same
  offscreen → image path, differing only in the per-pixel interpolation.

## Alternatives considered

- **Layered translucent radial gradients** (CSS/SVG, no per-pixel work) —
  rejected as the engine: alpha-composite muddiness, no real blend control. Kept
  only as the cheap **panel swatch** preview (`gradientCss`).
- **WebGL shader** — fastest and highest-quality, but a brand-new rendering
  dependency/path; overkill for a pragmatic v1. Reconsider if perf demands it.
- **Storing the baked bitmap on the node** — rejected; bloats the document and
  breaks re-editing the points.
