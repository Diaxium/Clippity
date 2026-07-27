# 0009 — Editor effects: inner shadow + spread

- **Status:** Accepted (implemented, PR-Pb.1)
- **Date:** 2026-06-04 · *reconstructed 2026-06-09 from program memory*
- **Area:** `app/frontend/src/features/editor` — both renderers

## Context

The `Effect` model already carried `inner-shadow` and `layer-blur` types plus a
`spread` field, but only **drop-shadow (without spread)** and **layer-blur**
actually rendered. `inner-shadow` and `spread` were dead data:

- Live SVG (`SceneNodeView` / `EffectsDefs`) drew only drop-shadow + layer-blur,
  and `hasEffects` explicitly excluded inner-shadow.
- Canvas2D export (`lib/render.ts`) found only `drop-shadow`.

Exposing them in the properties panel (PR-Pb's effect-type picker) without
rendering them would ship dead controls — and worse, controls that silently
disagree between the live canvas and the exported PNG. The editor's standing
invariant is that **every visual feature renders identically in both renderers**.

## Decision

Implement inner-shadow and drop-shadow spread in **both** renderers.

**Inner shadow**
- SVG (`EffectsDefs`): an inner-shadow filter recipe — `feFlood` the shadow
  colour, `feComposite operator="out"` against the source alpha to get the
  inverse silhouette, offset + `feGaussianBlur`, composite back over the shape.
- Canvas2D (`drawInnerShadow` in `render.ts`): clip to the shape, paint the
  inverse silhouette (fill + punch out the shape via `globalCompositeOperation`),
  offset + blur.

**Drop-shadow spread**
- SVG: `feMorphology operator="dilate"` with `radius = spread`, before the blur.
- Canvas2D: `spreadInflate` geometrically inflates the silhouette, cast through
  the off-canvas "shadow-only" trick (draw the silhouette to a temp canvas and
  use `ctx.shadow*` to cast it).

**UI** (`EffectsSection`): the per-effect type picker offers Drop shadow / Inner
shadow / Layer blur; the spread field ("S") shows on **drop-shadow rows only**.

## Consequences

- The effect-type picker is now fully backed — no dead controls.
- Deliberately **not** done (to avoid dead controls / silent mismatch):
  - **Inner-shadow spread** — a correct Canvas2D version needs morphological
    *erosion*, which the 2D API lacks; a scale-based fake renders an opaque band,
    not a shadow. The spread field is therefore hidden for inner shadows.
  - **Stacked multiple shadows** — still find-first per type.
  - **Shadows on text / line** nodes.
  - **Path-node shadows in the Canvas2D export** — SVG shadows path nodes,
    `render.ts` does not (pre-existing gap, recorded not fixed).
- Non-zero spread is visually consistent but **not pixel-identical** for
  polygon/star between SVG (`feMorphology`) and Canvas2D (geometric inflate).
- Pixel output is not unit-testable (jsdom has no canvas 2D); tests assert the
  SVG filter graph structure + the panel wiring, and the rendered result needs an
  in-app eyeball.

## Alternatives considered

- **Single-renderer (live only)** — rejected; the export must match.
- **Fake inner-shadow spread via scaling** — rejected; opaque band, not a shadow.
