# 0021 — Multi-select edits list rows by index, and reads through three primitives

- **Status:** Accepted (implemented)
- **Date:** 2026-07-20
- **Area:** `app/frontend/src/features/editor/{lib/multi.ts,hooks/useSelection.ts,components/panels/*,components/ColorPopover.tsx,state/editorStore.ts}`
- **Relates to:** editor roadmap **Workstream P3 / Fork P-F1**,
  [editor-tools](../roadmaps/editor-tools.md); reuses the P1 history transaction
  (`beginHistory`/`endHistory`) and the FE1 floating color editor

## Context

Until now the inspector rendered the **primary** selection — `sel[0]` — and
disabled its numeric fields whenever more than one node was selected. Selecting
three arrows and thickening them was three separate edits and three undo steps.
This was the largest remaining workflow papercut in an annotation tool, where
"draw four boxes, then make them all red" is an ordinary gesture.

The store's batch layer already existed and was **entirely uncalled**:
`updateNodes`, `updateEach`, `placeNodes`, and the plural
`updateFills`/`updateStrokes`/`updateEffects` (plus `colorEditor.peers`) had been
built in an earlier session with zero callers. So this decision is not about
*whether* to batch — the write side was settled — but about the two questions the
panels could not avoid answering: **what a list row means across a selection**,
and **what a field shows when the selection disagrees**.

## Decision

### 1. List rows are addressed by index (Fork P-F1)

The fill / stroke / effect sections lay out the **primary's** rows. Editing row
*i* writes to entry *i* of every selected node that has one; a node with a
shorter list is **skipped**, not extended.

The alternative — replace-all, where editing any row overwrites the whole paint
list on every selected node — was rejected because it destroys per-node paint
stacks on *every* edit. Nudging one shape's stroke width would silently flatten
another shape's two-stroke outline into one. For a design tool that is bad; for
an annotation tool, where a two-stroke halo is a common highlight treatment, it
is data loss triggered by a scrub.

`entriesAt` resolves the peers, `refsOf` strips them to the `{nodeId, entryId}`
pairs the store's plural actions take, and `sharedEntry` reads across them.

### 2. Three read primitives, chosen by what the property *means*

- **`shared`** — every node carries it (opacity, rotation, W/H). Disagreement is
  a real disagreement.
- **`sharedWhere`** — only some nodes carry it. Non-carriers **sit out** rather
  than counting as a disagreement, which is what lets a text-plus-rectangle
  selection still restyle the text, and three callouts plus a shape still swing
  the three tails.
- **`triState`** — booleans. A split renders unpressed (and indeterminate for
  checkboxes) so it never claims a state the selection doesn't have.

`shared` returns the primary's value **even when mixed**, because a scrub or
arrow-nudge on a mixed field has to start somewhere.

### 3. A mixed field is empty-with-placeholder, and stays live

`NumberField`/`ColorField` render blank with a `Mixed` placeholder rather than
the primary's number. They remain fully editable: typing, nudging or scrubbing
commits a real value to the whole selection — Figma's unify-the-selection
gesture. Crucially, the resting draft for a mixed field is `""`, and
`evalNumberExpression("")` is `null`, so **blurring an untouched mixed field
cannot silently unify the selection**.

For dropdowns (stroke alignment, font weight) a synthetic `Mixed` option is
prepended and selecting it is a no-op; picking any real option unifies.

### 4. Per-node patches where a shared patch would be wrong

Two cases cannot be expressed as one patch, and both write through `updateEach`:

- **W/H** — each node keeps *its own* aspect ratio. Two locked shapes at 1.25
  and 2.0 driven to width 200 must become 200×160 and 200×100, not both 200×160.
- **Corner radii** — each node keeps its *other* three corners.

`CalloutSection` and `SampleSection` do the same so a tail's angle edit doesn't
carry the primary's length along with it.

### 5. X/Y write through `placeNodes`, never a raw `x` patch

Nodes hold **absolute** coordinates, so patching a frame's `x` slides the frame
out from under its own children. `placeNodes` moves each node's *bounds* to the
target and carries descendants the way a drag does. On a multi-selection this
also gives "set X to 40" its useful reading: align everything to that
coordinate. The fields read `nodeBounds(n).x`, not `n.x`, so a rotated or
line-like node's displayed coordinate matches what the write moves.

### 6. The color popover reads the primary but writes primary + peers

`colorEditor.peers` (the same row on the rest of the selection, resolved by
`entriesAt` at open time) was already in the store and unread. `ColorPopover`
now writes through the plural actions to primary + peers, so one swatch, one
gradient and one set of stops still repaint the whole selection.

### 7. Step badges deliberately do **not** batch

`StepSection` shows only when exactly one badge is selected. A step number is a
node's place in a **sequence**, not a shared style: one value across a selection
flattens 1·2·3 into 3·3·3. This is the one field where the consistent rule is
the wrong rule, and hiding the control is more honest than offering one that
destroys the sequence.

Similarly out of scope by nature, not oversight: `BackdropSection` is
document-scoped (ADR 0020), and `ExportSection` exports the page or one node —
multi-node export is the separate "per-layer export rows" item in Phase 3.

## Consequences

- **Neither renderer changed**, and no new node fields were added — this is
  panel wiring over an existing store API, so two-renderer parity is untouched.
- **Every batch is one undo step**, inherited from the P1 history transaction
  via the store's plural actions rather than re-implemented per call site.
- Eleven sections now derive the selection from one place (`useSelection`)
  instead of re-deriving it with a copy-pasted `useMemo`. A new section that
  reintroduces the `sel[0]` + `disabled={multi}` pattern is a regression, and
  that is now written into the program doc's cross-cutting rules.
- `updateEach` / `placeNodes` went from dead code to load-bearing.
- The singular `updateStroke` / `updateEffect` store actions now have no callers
  outside the store (each plural is the single implementation, and the singular
  forms delegate to it). Kept for API symmetry with `updateFill`, which the
  canvas and toolbar still use.
- Sections that group (Shape by node type, Sample by sample mode) follow the
  **primary's** group. A selection spanning two groups edits one of them; the
  other sits out rather than being coerced into a shared field whose value would
  mean different things per node.

## Alternatives

- **Replace-all for paint lists.** Rejected — see §1. Destroys per-node paint
  stacks on every edit.
- **Union of rows instead of the primary's rows.** Rejected: the row count would
  change as the selection changes, rows would have no stable identity to edit
  against, and nodes would silently gain fills they never had.
- **Showing the primary's value on a mixed field (no "Mixed" state).** Rejected:
  it asserts a value two-thirds of the selection doesn't have, and any blur
  would commit that assertion to all of them.
- **Disabling fields on multi-select (the status quo).** Rejected: this is the
  papercut the work exists to remove.
- **A `MultiField` wrapper component per control.** Rejected as premature: the
  `mixed` boolean already existed on both field primitives, and the read is a
  one-line `shared(...)` at each call site. A wrapper would have added an
  indirection without removing one.
- **Batching step numbers anyway, for consistency.** Rejected — see §7.
