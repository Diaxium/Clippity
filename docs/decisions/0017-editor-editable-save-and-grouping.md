# 0017 — Editable scene save (JSON sidecar) + grouping via frames

- **Status:** Accepted (implemented)
- **Date:** 2026-06-14
- **Area:** `app/frontend/src/features/editor`, `app/backend/src/{domain,services}/editor*`
- **Relates to:** [0016 — keybind system](0016-editor-keybind-system.md)
  (the `Mod+S` / `Mod+G` bindings these implement were reserved there)

## Context

The keybind work (ADR 0016) reserved `Mod+S` (Save) and `Mod+G` / `Mod+Shift+G`
(Group/Ungroup) but left them as honest "Coming soon" no-ops: there was no
project-save backend (the editor backend was image-only — load a PNG, save a
*flattened* PNG) and no group node type. Both are now implemented.

Two facts made each tractable without a large rewrite:

1. `SceneDoc` (`{ rootIds, nodes }`) is already a clean, JSON-serializable unit,
   and image fills carry their pixels as embedded data URIs — so a scene is
   **self-contained**.
2. Editor nodes carry **absolute** scene coordinates and frames are **pure
   logical containers** (they clip + group but apply no transform to children;
   `moveNodes` already carries a container's descendants). So a "group" is just a
   tree restructure — no geometry recomputation.

## Decision

**1. Save = an editable JSON sidecar, non-destructive.** A new
`editor_save_scene(id, scene)` writes the frontend-owned document JSON to
`<captures>/.scenes/<file>.json`. The `.scenes` dir is dot-prefixed so the
library scan (which already skips `.`-entries like `.trash`) never lists scene
files as captures — important because `kind_of` defaults unknown extensions to
`Image`. The original capture PNG is **never modified**, so the source pixels
can't be lost. `editor_load` now returns the sidecar's contents in a new
`EditorImage.scene` field; the editor restores the editable scene when present
and falls back to seeding from the flat image when it's absent or malformed
(`parseDocument` is version-checked and total). The document is a versioned
envelope (`lib/document.ts`); `useEditorSave` + `markSaved` drive the
Draft→Edited→Saved status.

**2. Counter reseed on restore.** Node/paint ids are `<prefix>_<base36>` drawn
from one module counter that resets to 0 each session. Restoring a scene with
ids from a prior session would collide with freshly-created ones, so
`reseedNodeIds` scans every restored id (nodes + fills/strokes/effects/gradient
stops) and advances the counter past the maximum.

**3. Grouping reuses the frame node.** `group()` wraps the top-level selection
in a new **non-clipping** `Group` frame (`clipContent: false`, no fills/strokes),
ordering members by a DFS paint rank and placing the group at the frontmost
member's z-slot under its shared parent (mixed parents → root). `ungroup()`
splices a selected frame's children back into its slot. Both are a single
`mutate` (one undo step); no node coordinates change because frames don't
transform children.

**4. `mutate` flips `saved` → `edited`.** Previously the status computation only
promoted `draft` → `edited`; with a reachable `saved` state, any real change now
sets `edited` so the pill reflects unsaved work.

## Consequences

- "Open a capture, annotate, `Mod+S`, close, re-open, keep editing" works
  end-to-end. Save is also in the document-title menu (discoverable without the
  keybind).
- New backend surface: `EditorImage.scene`, `editor_save_scene`,
  `editor::scene_file_name`, `EditorService::{save_scene, scene_path}`. New
  frontend surface: `editorSaveScene`, `lib/document.ts`, `reseedNodeIds`,
  `sceneFromSaved`, `useEditorSave`, store `markSaved` / `group` / `ungroup` /
  `SceneInit.status`.
- **Ungroup dissolves any selected frame**, including a user-drawn frame — there
  is no separate group type to distinguish them.
- The library preview thumbnail is **not** refreshed on save (the PNG is
  untouched); the scene also duplicates the base image (embedded data URI), so
  sidecars are larger than the PNG. Both are documented follow-ups.
- Tests: +4 Rust (sidecar round-trip, no-sidecar, path-escape, `scene_file_name`)
  and +17 TS (document round-trip/parse, reseed, `sceneFromSaved`, save hook,
  group/ungroup, status). 279 Rust + 690 TS green.

## Alternatives considered

- **Overwrite the capture PNG with the flattened render on save.** Rejected for
  v1 — destructive (the original screenshot would survive only inside the
  sidecar). Export (`Mod+E`) remains the "render to a new file" path.
- **Store the scene by *reference* to the source path instead of embedding the
  image.** Rejected — a moved/trashed capture would break the project. Embedding
  keeps it portable; size is a documented trade-off.
- **A separate `group` node type.** Deferred — frames already provide containment
  with absolute-coord children, so grouping needed zero new rendering/hit-testing.
  A dedicated type (to diverge group vs frame semantics) can come later.
- **A bespoke binary document format.** Overkill — JSON is debuggable, diffable,
  and `serde`/`JSON.parse` make it free on both sides.
