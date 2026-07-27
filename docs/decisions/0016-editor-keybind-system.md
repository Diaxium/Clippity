# 0016 — Centralized editor keybind system (Figma + Illustrator hybrid)

- **Status:** Accepted (implemented)
- **Date:** 2026-06-13
- **Area:** `app/frontend/src/features/editor`
- **Relates to:** [editor-keybinds.md](../reference/editor-keybinds.md) (full shortcut
  reference)

## Context

Editor keyboard handling was **fragmented**: a monolithic `keydown` `useEffect`
in `EditorLayout` (undo/redo, clipboard, z-order, zoom, delete, tool letters via
`TOOL_SHORTCUTS`), a separate Space-to-pan effect + a duplicated `isTypingTarget`
in `EditorCanvas`, and a pen `Esc`/`Enter` effect. There was no nudge, deselect,
cut, lock/hide, zoom-to-selection, save/export, or help overlay; no
platform-aware display; no conflict detection; and no path toward
user-customizable bindings. The brief asked for a polished **Figma + Illustrator
hybrid** that stays familiar to designers while keeping Clippity's
capture/annotation workflows intact.

Two facts shaped the design:

1. Proportional resize (`Shift`), center resize (`Alt`), one-undo-per-drag, and
   the inspector aspect-lock (`node.lockAspect`) **already existed** in
   `geometry.ts::resizeFrame` + the canvas + `LayoutSection`. The task was to
   centralize *keybinds*, not rebuild transforms.
2. Several "ideal" tool letters clashed with shipped tools (`A`=Arrow not
   Direct-Select, `I`=Image not Eyedropper, `M` unused). Existing tools have
   tooltips, tests, and muscle memory.

## Decision

**1. A declarative registry + one window listener.** New `editor/keybinds/`
module:

- `keybindTypes.ts` — `EditorKeybind` (id, label, category, `keys[]`, context,
  `coalesce`, key handlers), `CommandCtx` (`{ store, event, api }`), `KeybindApi`.
- `editorKeybinds.ts` — `EDITOR_KEYBINDS`: the default map. Tool bindings are
  **derived from `TOOLS`** (single source of truth), so the tooltip, help
  overlay, and binding never drift.
- `keybindRegistry.ts` — a signature→binding index, context resolution, conflict
  report, and the help grouping.
- `useEditorKeybinds.ts` — the single `keydown`/`keyup`/`blur` listener; owns
  history coalescing.

`EditorLayout`'s inline handler and the canvas's bespoke Space effect are
**deleted**; the canvas reads a `tempPan` store flag instead.

**2. `Mod` abstraction + layout-stable matching.** Bindings are written once with
`Mod` (Ctrl⇄Cmd collapse at match time; render as `⌘`/`Ctrl` at display time).
Main keys derive from `KeyboardEvent.code` (`Shift+1`/`Shift+=` don't mutate into
`!`/`+`), with named keys (`ArrowUp`, `Space`, `Escape`) from `key`.

**3. Context layering, not ad-hoc guards.** `textEditing > selection > editor`;
dispatch fires the single highest-priority **active** binding, and
`preventDefault` only when handled. Typing surfaces (`isTypingTarget`) suppress
shortcuts; the inline text editor + help overlay own their own `Esc`.

**4. Existing tool letters win; gaps are documented, not faked.** `A`/`I`/`R`
keep their shipped meanings. Grouping (`Mod+G`) and Save (`Mod+S`) have no
backend — they are **registered + surfaced as "Coming soon" / a non-blocking
message** rather than swallowed or faked. No eyedropper/crop/zoom tool ⇒ `C`/`Z`
stay unbound.

**5. Temporary pan via a `tempPan` flag, not a tool swap.** `Space` sets
`tempPan`; the canvas grab-pans (reusing the `tool === "hand"` path) and the tool
is **preserved** on release — matching Figma, and avoiding toolbar-primary drift
or cancelling an open pen path.

**6. History coalescing in the hook.** `coalesce` bindings (arrow nudge, keyboard
resize) open one lazy `begin/endHistory` transaction, closed after an idle gap
(or on blur), so a held burst is one undo step. Reuses the store's existing lazy
snapshot.

## Consequences

- One discoverable place for every editor key; `?` opens a generated overlay that
  can't drift. New store actions: `toggleLockSelected`, `toggleHideSelected`,
  `resizeSelectedBy`, `zoomToSelection`/`fitSelection`, `setTempPan`,
  `setHelpOpen`/`toggleHelp`, `requestExport`.
- Conflict detection (`findKeybindConflicts`, dev-warned + test-asserted empty)
  makes future bindings safe to add.
- The declarative, conflict-checked registry is the groundwork for
  **user-customizable keybinds** (override `keys[]` per `id`, re-validate).
- Visible cue: the `TransformHud` shows a lock glyph during a proportional
  resize.
- Net new tests: +48 (geometry center/aspect, store actions, registry/util,
  hook behavior, overlay) — 669 app-wide green.

## Alternatives considered

- **Keep the inline handler, just add cases.** Rejected — it was already
  unscalable and had no conflict/help/platform story.
- **`Space` swaps the active tool to Hand.** Rejected — drifts the toolbar
  primary and cancels open pen paths; a `tempPan` flag is closer to Figma.
- **Fold `sample`-style grouping in via frames.** Rejected — frames carry
  clip/corner semantics; faking groups would mislead. Reserved keys + a "Coming
  soon" note are honest.
- **A keybind library (hotkeys-js / mousetrap).** Rejected — the brief warns
  against heavy deps for this; a ~200-line registry covers contexts, `keyup`,
  coalescing, and platform display exactly as needed.
