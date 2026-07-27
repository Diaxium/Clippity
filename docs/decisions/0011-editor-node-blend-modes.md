# 0011 — Editor node blend modes

- **Status:** Accepted (implemented, Workstream A3 — Fork A-F1)
- **Date:** 2026-06-04 · *reconstructed 2026-06-09 from program memory*
- **Area:** `app/frontend/src/features/editor` — both renderers

## Context

The Highlighter tool needs a translucent marker that lets the screenshot read
through it (white background → tint, dark text → preserved) — i.e. **multiply**
blending. The scene model had no concept of blend mode at all. Blending is also
generally useful beyond the highlighter.

## Decision

Add an optional **`blendMode?: BlendMode` on `NodeBase`**. The key property: the
**same string value is valid in both rendering APIs**, so there is no mapping
table —

- SVG: `mix-blend-mode` on the node's `<g>` (`SceneNodeView`).
- Canvas2D: `ctx.globalCompositeOperation` in `drawNode` (`render.ts`).

`BlendMode` is the set of separable modes common to both: `normal`, `multiply`,
`screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`,
`hard-light`, `soft-light`, `difference`, `exclusion`.

The **Highlighter** tool is then just: a yellow rectangle + `blendMode:
"multiply"` + no stroke (Snagit's rectangular Highlight, not a freehand marker).

## Consequences

- Reusable for any future node that needs blending, not just the highlighter.
- Because the mapping is 1:1, correctness was verifiable by reasoning — this is
  why blend modes (A3) were sequenced **before** pixelate (A2.1), which needed a
  pixel approach that can't be reasoned about as cleanly.
- A freehand marker-stroke highlighter variant remains a follow-up.

## Alternatives considered

- **Per-renderer blend-mode mapping table** — unnecessary; the keywords already
  match across SVG and Canvas2D.
- **A dedicated highlight node type** — rejected; blending is a general node
  property, and the highlighter is just a preset over it.
