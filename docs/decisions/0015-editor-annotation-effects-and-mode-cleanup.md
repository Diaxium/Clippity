# 0015 — Annotation sample effects in Design mode, redaction removal, magnifier clip

- **Status:** Accepted (implemented)
- **Date:** 2026-06-13
- **Area:** `app/frontend/src/features/editor`
- **Relates to:** [0010 — sample regions](0010-editor-sample-regions-blur-magnifier.md),
  [0012 — pixelate sample regions](0012-editor-pixelate-sample-regions.md)

## Context

Blur / Pixelate / Magnifier are modelled as an optional `sample?: SampleSpec` on
a node (ADR 0010/0012), edited through a bespoke `SampleSection` panel that showed
in **both** editor modes. Three problems:

1. In **Design mode** the sample appeared as a custom annotation panel rather than
   as a normal, editable **effect**, so design editing carried a one-off concept.
2. **Redact** was its own tool/mode, but a redaction is just a black-filled
   rectangle — fully reproducible with the rectangle + fill tools.
3. The **Magnifier**'s live SVG put the zoom `transform` and the `clip-path` on the
   *same* `<image>`, so the clip scaled with the zoom and the loupe bled past its
   shape by the zoom factor. (The Canvas2D export already clips-then-scales, so it
   was correct — the two renderers disagreed.)

## Decision

**1. Keep `sample` as the data model; unify only the presentation.** A sample is
mutually exclusive and one-per-node, so it is *not* folded into the `effects[]`
list (that would mix a backdrop-replacing sample with compositing post-effects,
and "reorder" relative to shadows has no meaning). Instead:

- `SampleSection` is now **Annotate-mode only**.
- In **Design mode** the sample renders as the **first row of the Effects
  section** — a type dropdown (Blur / Pixelate / Magnifier), the mode's amount
  field, a visibility eye, and a remove button (which clears `sample`). It reads
  and behaves like the shadow/blur rows beside it.
- New `SampleSpec.enabled?: boolean` backs the eye toggle (absent = visible).
  Both renderers skip a disabled sample, falling through to the node's (empty)
  fills — i.e. the region reveals the original capture beneath.
- `SAMPLE_DEFAULT_AMOUNT` centralises the per-mode seed; switching the mode in the
  Effects row resets the amount to that mode's default (units differ: px / cell / ×).
- **Applicable to any area shape, not just the annotation tools.** A sample paints
  for rectangle, ellipse, image, polygon, star, and pen/pencil **path** nodes
  (`canCarrySample`), each clipped to its own outline — in both renderers. (The
  annotation tools still only draw rect/ellipse; this is the Design-mode reach.)
  Excluded: frames (containers), text, and line-like nodes (no fillable area).
- **The sample composites *behind* the fills, not in place of them.** The node
  keeps its fills; the sample paints first (the backdrop), then the fills over it
  — so a translucent fill tints the sampled region (frosted glass) and the fill
  stays a normal editable property. The Canvas2D export already drew
  sample-then-fills; the live SVG now matches it (it had made the two mutually
  exclusive). A fill-less annotation region (the tools' default) is unchanged.
- **One unified, convertible type dropdown.** Every effect row's type picker offers
  the shadows *and* the three sample modes. Picking a sample on a shadow row moves
  it into `node.sample` (and removes the `effects[]` entry); picking a shadow on the
  sample row does the reverse — one undo step via a history transaction. Sample
  options are hidden when the node already holds a sample (one per node) or can't
  carry one, which keeps the single-sample invariant without extra state.

**2. Remove the Redact tool/mode.** Dropped from `ToolId`, `TOOL_MODES`, the
toolbar, and the `defaultFills`/`defaultStrokes`/`createNodeForTool` switches.
Users draw a rectangle and set a black fill.

**3. Fix the Magnifier clip (live SVG).** Clip on an *untransformed* `<g>` and
scale the `<image>` inside it, so the clip stays the node's unscaled shape — and
matches the export's clip-then-scale. The shape clip respects rounded corners /
ellipse bounds as before, and the ring stroke remains the visible edge.

## Consequences

- Design mode is "normal object editing": annotations are inspectable, adjustable,
  and removable as standard effects, with no extra scene-graph concept.
- No data migration: existing `sample` documents render and edit unchanged; the
  change is presentation + a rendering-order/clip fix.
- A hidden sample shows the fills (or, for a fill-less region, the capture
  underneath) — a natural "preview original".
- Reordering a sample among shadows is intentionally not offered (a sample always
  paints at the fill layer — behind the fills, in front of a drop shadow).
- Redaction is gone from the toolbar; one fewer tool to learn, no lost capability.

## Alternatives considered

- **Promote samples to real `Effect` entries** — rejected: pollutes `Effect` with
  sample-only fields, mixes "replace the layer with backdrop" against "composite a
  shadow," and needs guards for multiple/ordered samples — all for no user-visible
  gain over surfacing `sample` as a row.
- **Keep `SampleSection` in Design mode** — rejected: the request is explicitly to
  treat these as standard effects, not a bespoke annotation property.
- **Clip the magnifier by pre-dividing the clip by the zoom** — rejected: fragile
  for rounded/ellipse clips; the group/image split is exact and mirrors the export.
