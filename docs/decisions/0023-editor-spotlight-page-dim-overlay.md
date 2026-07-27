# 0023 — Spotlight is a page-dim scrim with the region punched out, and one shared even-odd path

- **Status:** Accepted (implemented)
- **Date:** 2026-07-20
- **Area:** `app/frontend/src/features/editor/{lib/spotlight.ts,components/SceneNodeView.tsx,lib/render.ts,components/panels/SpotlightSection.tsx,state/editorStore.ts,tools.ts,types.ts}`
- **Relates to:** [0022 — window chrome](0022-editor-window-chrome-above-the-capture.md)
  (the shared-geometry-module pattern this reuses),
  [0019 — crop resizes the page frame](0019-editor-crop-resizes-the-page-frame.md)
  and [0020 — the page backdrop](0020-editor-page-backdrop-from-existing-primitives.md)
  (the page model + the sealing this inherits),
  [0011 — node blend modes](0011-editor-node-blend-modes.md) and
  [0010 — sample regions](0010-editor-sample-regions-blur-magnifier.md)
  (the "property on a box shape, not a new node type" precedent), editor roadmap
  Workstream A / **Fork A-F2**, [editor-tools](../roadmaps/editor-tools.md)

## Context

A spotlight dims the whole capture except a chosen region, to steer the eye —
Snagit's "spotlight & magnify", minus the zoom. It rounds out the annotation set
after Fork F4 (crop/backdrop/chrome) and is the item the program doc named as the
recommended next one, precisely because it is the closest structural match to the
chrome that had just shipped: **another feature with no existing primitive.**

Every other annotation renders inside its own frame — a callout's tail, a step
badge's number, a blur's sampled pixels all stay within the node's box. A
spotlight is the exception: its entire point is to affect **everything else**, so
its effect reaches the full page. That is the same situation window chrome was in
(a bar *outside* the node), and it takes the same answer.

## Decision

**1. Spotlight is a `spotlight` property on a box shape, not a new node type.**
A rectangle or ellipse carries a `SpotlightSpec {color, opacity}`; its frame is
the clear region. This is the resolution every annotation before it reached —
blur/pixelate/magnify are a `sample` property (ADR 0010), highlight is a
`blendMode` (ADR 0011), callouts a `callout` property, chrome a `chrome`
property. The node keeps its transform handles, z-order, undo, and sidecar
round-trip for free, and the renderers special-case one field.

**2. One shared geometry module, `lib/spotlight.ts`, hands both renderers a
single even-odd path.** `spotlightScrim(node, nodes)` returns
`{ d, color, opacity }` where `d` is the **page rect concatenated with the
node's hole**. Filled even-odd, the hole reads clear and the rest of the page
dims. The live SVG emits `<path d fill-rule="evenodd">`; the Canvas2D export
fills `new Path2D(d)` with `"evenodd"`. One path, two spellings — the ADR 0022
contract, taken one step further: chrome shared *numbers* and let each renderer
build its own path; here the path itself is shared, so there is even less room to
drift. The hole reuses the node's own outline primitives — `roundedRectPath` for
a rectangle (the same function `cornerPath` traces), two exact half-arcs for an
ellipse (matching `<ellipse>` / `ctx.ellipse`) — so the punch-out can never
disagree with how the shape is drawn everywhere else.

**3. The scrim covers the *page frame's* rect, resolved without `rootIds`.** The
renderers don't have the root list, so `spotlightPageRect(nodes)` walks up from
the capture (`findBaseImage`, the node the page model already treats) to its
**outermost frame ancestor** — the page frame. That rect is bar-inclusive when
window chrome grew the page (ADR 0022 measured the margin against
`chromeWindowRect`), so a spotlight composes with chrome for free. It falls back
to the capture's own window rect when there is no frame ancestor, and null when
there is no capture — which is what makes a spotlight inert rather than dimming
nothing.

**4. Applying a spotlight seals the page** (`absorbRootsIntoPage`, in the same
undo step as the node's creation). See the trap section below — this is the
load-bearing half.

**5. The panel is a per-selection section beside Callout/Step,** shown whenever
the selection contains a spotlight. It offers **Dim** (opacity, as a percentage)
and **Tint** (dark for a light capture, light for a dark one) — a short chip list
rather than a full picker, because a spotlight's only real variables are how much
to dim and which way, and the dim is meant to vanish against the content, not be
a design accent. It batches through `updateEach` (P3 / ADR 0021) so a
multi-selection of spotlights dims together while each keeps the rest of its own
spec.

## The export-region trap, reached a fourth way

ADR 0019 documented it for crop, 0020 for padding/backdrop, 0022 for chrome.
Spotlight reaches it a fourth time, from a new direction: the scrim covers the
**page frame's rect**, and both renderers size the export from `unionBounds` of
the *root* nodes. Annotations do not reliably live inside the page — anything
drawn past the image edge, pasted, or ungrouped is a **sibling root**. A stray
root sitting outside the page therefore stretches the export region past the
scrim, and that overhang exports as an **undimmed band** — a page dimmed on three
sides and raw on the fourth, invisible on the live canvas and visible only in the
saved file.

The answer is the one the page model already prescribes: adding a spotlight runs
`absorbRootsIntoPage`, so the page frame is the sole root and the page rect *is*
the document extent. The scrim then covers all of it. Verified against the
running editor on the smoke harness, whose seeded scene has eight stray
annotation roots:

```
before:  9 roots
after:   1 root
page rect:      x 0 … 1100,  y 0 … 720
export region:  x 0 … 1100,  y 0 … 720   ← equal, no undimmed band
```

Two-renderer parity was verified the same way (the export can disagree with the
canvas, which is where this editor's real bugs hide). The Canvas2D export of the
smoke scene with a 60%-dark spotlight:

```
inside the region (500,410):   [255,255,255] → [255,255,255]   (untouched)
outside, over white (900,160): [255,255,255] → [109,110,114]   = 0.4·255 + 0.6·#0b0e14
```

The SVG emits the identical scrim: `d = "M0,0 H1100 V720 H0 Z M320,300 …"`,
`fill #0b0e14`, `fill-opacity 0.6`.

## Consequences

- Both renderers gained one branch, held together by the shared path — the
  ADR 0022 cost, paid once more for the one annotation that warranted it.
- **Sealing is a side effect of drawing a spotlight.** Unlike other annotation
  tools, starting a spotlight folds every stray root into the page frame. This is
  consistent with crop/backdrop/chrome (all seal) and is what the page-model
  invariant requires; it is one undo step, and undo restores the prior root
  structure exactly.
- **Default z-order places the spotlight just above the capture,** below
  annotations added earlier — so it dims the screenshot while callouts/arrows
  stay bright, which is the common intent. What a spotlight dims is its z-order;
  the standard bring-forward / send-backward controls adjust it.
- The scrim never expands the export region: `exportBounds(spotlightNode)` is its
  `rotatedAABB` (the hole), not the scrim, and after sealing the node is a page
  *child* that doesn't count toward the root union at all.
- Stored as a plain optional field, so ADR 0017's sidecar round-trips it with **no
  migration** — an older sidecar simply has no `spotlight`.
- `spotlightScrim` clamps opacity on read, so a hand-edited sidecar can't emit an
  out-of-range fill.
- No backend work.

## Alternatives

- **A dedicated overlay node type.** Rejected for the reason every annotation
  before it was: a property on an existing box shape inherits transform, z-order,
  undo, and persistence, where a new type re-implements all four. (ADR 0010/0011.)
- **A property of the page frame (like the backdrop).** Rejected: the region must
  be an interactive object the user drags and resizes, which the transform
  handles give a *node* and not a page property; and one page can hold several
  spotlights.
- **Thread the page rect (or `rootIds`) into both renderers.** Rejected: it
  touches the generic, deeply-recursive, memoized `SceneNodeView` draw path for
  one feature. `spotlightPageRect(nodes)` derives the rect locally instead.
- **An oversized scrim clipped by the page frame, no exact page rect.** Rejected:
  correct only when the spotlight is a page *child*; a sibling-root spotlight
  would spill the scrim onto the editor background. Sealing + the exact page rect
  is correct regardless of tree position.
- **An SVG `<mask>` with native `<rect>`/`<ellipse>` instead of an even-odd
  path.** Workable, but heavier markup and a second geometry spelling. The
  even-odd path is symmetric with the Canvas2D side (both fill one path
  even-odd) and reuses the node's own outline math.
- **Not sealing; instead covering the union of all node bounds.** Rejected: it
  over-dims the editor background between the page and any far stray on the live
  canvas. Sealing keeps the scrim exactly the page.
