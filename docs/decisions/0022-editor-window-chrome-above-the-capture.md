# 0022 — Window chrome is a bar above the capture, and one shared geometry module

- **Status:** Accepted (implemented)
- **Date:** 2026-07-20
- **Area:** `app/frontend/src/features/editor/{lib/chrome.ts,lib/page.ts,components/SceneNodeView.tsx,lib/render.ts,components/panels/ChromeSection.tsx,state/editorStore.ts,types.ts}`
- **Relates to:** [0019 — crop resizes the page frame](0019-editor-crop-resizes-the-page-frame.md)
  and [0020 — the page backdrop](0020-editor-page-backdrop-from-existing-primitives.md)
  (the page model this builds on), [0017 — editable save](0017-editor-editable-save-and-grouping.md)
  (the sidecar that persists it), editor roadmap Phase 2 / **Fork F4**,
  [editor-tools](../roadmaps/editor-tools.md)

## Context

Window chrome — a macOS or Windows title bar around the screenshot — is the
third and last slice of Fork F4, after crop (ADR 0019) and the backdrop
(ADR 0020). It is also the slice both of those ADRs explicitly deferred, for one
reason: **it is the only part of F4 with no existing primitive to reuse.**

Crop and backdrop earned their two-renderer parity by changing *neither*
renderer — padding is the page frame's rect, the backdrop is its `fills`, the
content treatment is `cornerRadius` plus a drop-shadow `Effect`, and both
renderers already drew all of those. Traffic lights do not fall out of anything
the scene graph already has. So this change had to do the thing the previous two
were designed to avoid: add a branch to the live SVG renderer *and* the Canvas2D
export, and keep them in agreement.

## Decision

**1. The bar lives above the capture's rect, not inside it.** The capture node
keeps its own box; `chrome.height` px directly above it is the bar. The
alternative — reserving the top of the node's box and insetting the image —
would have required both renderers to learn a "content rect" distinct from the
node rect, touching every fill path rather than adding one branch.

Three properties follow from placing it outside:

- the capture's pixels are never covered or shifted, so chrome is exactly as
  non-destructive as crop and padding, and composes with them;
- the node's **outline** becomes the whole window (`chromeWindowRect`), which is
  what both renderers already use for the clip, the strokes, and the drop
  shadow — so a lift shadow lifts the bar *with* the image instead of casting a
  seam across the join, and the window's rounded corners land on the bar's top
  and the capture's bottom with no extra code;
- the page must make room for the bar, which is decision 3.

**2. One shared geometry module, `lib/chrome.ts`.** Every number either renderer
needs — bar rect, window rect and radii, traffic-light circles, Windows caption
polylines, title placement, ink, separator — is computed there. Each renderer
only decides how to *emit* it: SVG elements, or Canvas2D calls. This is the same
contract `calloutOutline` and `polygonOutline` already hold, and it is the whole
answer to "how do two branches not drift". Testing the module tests both
renderers' geometry at once, which matters because the Canvas2D path cannot be
unit-tested at all (jsdom has no 2D context).

A consequence worth naming: **the Windows caption buttons are strokes, not
glyphs.** A font would have made the two renderers depend on matching text
metrics — precisely the class of divergence this module exists to prevent.

**3. `pageContent` reports the *window* rect, so padding surrounds the bar.**
The page frame clips its children. Writing the spec alone would therefore hide
the bar behind the page's own top edge on any document with less padding than
the bar is tall. Rather than teach the page model a second rect, `pageContent`
now returns `chromeWindowRect(capture)` — equal to the capture's rect until
chrome exists — and every existing padding read and write composes unchanged.

`setWindowChrome` then measures the margin against the *old* window, applies the
spec, and re-applies the same margin against the *new* one, all in one undo step.
A page with no padding grows by exactly the bar; a page with 48px keeps 48px on
all four sides; clearing chrome runs the identical path in reverse so the page
shrinks back instead of leaving an unexplained band of backdrop.

Because it routes through `setPagePadding`, it inherits ADR 0020's sealing
(`absorbRootsIntoPage`) and its forced `clipContent` for free — see below.

**4. Applying chrome to a square-cornered capture also rounds it,** in the same
undo step, for the reason `applyBackdrop` opens a default margin: a window with
sharp corners reads as a rendering bug rather than a style choice.

**5. The panel is document-scoped and sits beside Backdrop.** Same reasoning as
ADR 0020 §6 — this edits the page treatment, not a selected mark, and an empty
selection is how the page stays reachable in Annotation mode where the Layers
rail is hidden. It hides entirely when the capture can't carry chrome: the
capture is whatever holds the largest image fill, so an ellipse can qualify, and
neither renderer has a title-bar path for one. Same guard the Corners field uses.

## The export-region trap, reached a third way

ADR 0019 documented it for crop and ADR 0020 hit it again from padding. Chrome
reaches it a third time, because growing the page to fit the bar is the same
edit that exposes it: a stray annotation root outside the page stretches
`unionBounds` past the backdrop, and the overhang exports as an unpainted band
that is **invisible on the live canvas and visible only in the saved file**.

Routing through `setPagePadding` inherits the fix rather than re-deriving it.
Verified against the running editor on the smoke harness, whose seeded scene has
eight stray annotation roots:

```
before:  9 roots
after:   1 root
page rect:      x 0 … 1100,  y -36 … 720
export region:  x 0 … 1100,  y -36 … 720   ← equal, bar included
```

## Found while building: the *per-node* export sliced the bar off

The whole-page export was correct by construction (the page grew, and the page
is the root). The **Export panel's single-node export** was not: it sized the
bitmap from `rotatedAABB(node)`, which measures the node's *frame* — so
selecting the capture and exporting it produced an image with the title bar
cropped away. The same class of bug as the trap above, and equally invisible
until you open the file.

Fixed with `exportBounds` in `render.ts` — the rotated AABB grown to include the
chrome, applied to **both** export paths. Deliberately *not* folded into
`rotatedAABB` itself: that function also backs selection chrome, hit-testing and
zoom-to-selection, where the node's own box is the right answer.

## Consequences

- Both renderers gained a branch. That is the cost this fork was always going to
  pay, and the shared module is what keeps it to *one* branch each rather than
  two implementations.
- The node's **selection bounds stay the capture's box**, not the window's. The
  bar is a decoration of the capture, and extending hit-testing and the eight
  resize handles over it would have meant touching the transform engine for a
  region with nothing to grab. Selecting the capture shows its own box; the bar
  follows it. The export is the one place that must disagree — hence
  `exportBounds` above.
- Chrome is stored on the node as a plain optional field, so ADR 0017's sidecar
  round-trips it with **no migration** — an older sidecar simply has no `chrome`,
  which is the "no chrome" state.
- `chromeHeight` clamps on **read** as well as write, so a hand-edited sidecar
  can't produce a page the export then tries to rasterize.
- Cropping inward past the bar trims it, exactly as crop trims anything else.
  This is consistent, and it is the pre-existing convergence behaviour of
  `pagePadding` (it reports the minimum of the four gaps; writing re-normalizes).
- No backend work — as the roadmap predicted for the whole of F4.

## Alternatives

- **Reserve the top of the node's box and inset the image fill.** Rejected: it
  makes the node rect and the drawn image rect disagree, which every fill path,
  the image-scale/align logic, and `findBaseImage`'s sampling would each have to
  learn. One branch became five.
- **A wrapper "window" frame containing the capture.** Rejected for ADR 0019's
  reason: the seeded page frame is already the only container the document has,
  a second one duplicates the concept, and it breaks saved sidecars.
- **Chrome as a property of the page frame.** Rejected: the bar has to hug the
  capture, and the page is the backdrop — with any padding at all the two rects
  are different, and the bar would float detached from the screenshot.
- **A glyph font for the Windows caption buttons.** Rejected: it couples the two
  renderers through text metrics. See decision 2.
- **Rasterizing the chrome into the capture bitmap.** Rejected for ADR 0020's
  reason: destructive, un-editable after save, and it would force a
  frontend-only feature through the backend for no benefit.
- **Storing a separate `chromeHeight` on the page.** Rejected: a second source
  of truth for a rect that already exists — the same trap "padding is derived"
  was created to avoid.
