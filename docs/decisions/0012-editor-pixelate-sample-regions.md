# 0012 — Editor pixelate sample regions

- **Status:** Accepted (implemented, Workstream A2.1)
- **Date:** 2026-06-08 · *recorded 2026-06-09*
- **Area:** `app/frontend/src/features/editor` — both renderers
- **Extends:** [0010 — sample regions: blur + magnifier](0010-editor-sample-regions-blur-magnifier.md)

## Context

ADR 0010 introduced `sample?: SampleSpec` regions and shipped Blur + Magnifier.
The third mode, `pixelate`, was modelled but unimplemented — it fell back to
blur. It was deferred because **SVG has no reliable native mosaic/pixelate
filter**: nested-scaling and `image-rendering: pixelated` tricks don't compose to
a true downsample-then-nearest-upsample in the SVG vector pipeline, and behave
inconsistently across engines. Blur and Magnifier got away with pure SVG
(`feGaussianBlur` / a `transform` scale); pixelate cannot.

## Decision

Render pixelate by **offscreen-canvas rasterisation**, shared by both renderers
through one helper, `lib/sample.ts#pixelateRegion(img, baseRect, region, cell)`:

1. Cover-draw the slice of the base image under the region into a region-sized
   canvas (translated so the region's top-left maps to the origin).
2. **Average-downsample** to one pixel per `cell` (`imageSmoothingEnabled = true`).
3. **Nearest-neighbour upsample** back to region size (`imageSmoothingEnabled =
   false`) → hard block edges.

Returns a region-sized canvas, or `null` when no 2D context is available (e.g.
jsdom). The grid is anchored to the region's top-left and the algorithm is
identical on both sides, so **live == export**.

- **Export** (`render.ts#drawSample`): draw the returned canvas at the node's
  local box, within the existing shape clip.
- **Live** (`SceneNodeView`): a new `PixelatedImage` component async-rasterises
  via a cached `loadImage` + `pixelateRegion` inside an effect keyed on the
  **primitive** geometry fields. Until the first mosaic is ready it paints a
  neutral `#8b8f96` **privacy placeholder** — it must never briefly reveal the
  original pixels — and keeps the previous mosaic up during a recompute (still
  obscured) to avoid a gray flicker on resize.
- `drawCover` moved into `lib/sample.ts` as the single shared cover-math source.
- `SampleSection` is now 3-mode via `SAMPLE_CFG` (blur "Amount" px / pixelate
  "Cell size" px / magnify "Zoom" ×).

The `pixelate` tool: `ToolId` + `ToolDef` (icon `Grid2x2`, annotate-only),
placed in the annotate group after blur; `createNodeForTool("pixelate")` →
rectangle + `sample { mode: "pixelate", amount: 12 }`.

## Consequences

- The live view now needs an **async image decode + component state** — heavier
  than Blur/Magnifier's stateless pure-SVG approach. Accepted: pure-SVG pixelate
  is unreliable, and this is the deterministic path.
- Pixel output is **not unit-testable** in jsdom (no canvas 2D, and `loadImage`
  never resolves there). Tests cover the factory, the SVG **placeholder** path,
  the panel label, and the toolbar entry; the mosaic itself needs an in-app
  eyeball.
- Like all sample regions, it reflects the **capture**, not other annotations
  beneath it.

### Why a new ADR rather than amending 0010

The rendering **mechanism** is fundamentally different — offscreen-canvas raster
vs. SVG filter/transform — and carries its own privacy-placeholder and
async-decode consequences. That's a distinct decision, so it gets its own record.

## Alternatives considered

- **SVG `feImage` / `image-rendering: pixelated` hacks** — rejected; unreliable
  across engines, the reason pixelate was deferred from A2.
- **Storing the pixelated bitmap on the node** — rejected; bloats the document
  and breaks re-pixelation when the region is resized.
