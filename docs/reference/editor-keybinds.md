# Editor keyboard shortcuts

Clippity's editor is keyboard-first. Shortcuts are a **Figma + Illustrator
hybrid**: Figma conventions for the modern canvas/design surface, Illustrator
conventions for vector/object/selection workflows, and common OS conventions for
file/clipboard/history. Where Clippity already shipped a tool letter that clashed
with the "ideal" map, the **existing tool wins** (muscle memory + existing
tests + tooltips beat a letter) and the deviation is documented below.

Press **`?`** in the editor for the in-app overlay — it is generated from the
same registry described here, so it never drifts.

## Architecture

```
features/editor/keybinds/
  keybindTypes.ts       — EditorKeybind, KeybindCategory/Context, CommandCtx, KeybindApi
  keybindUtils.ts       — platform detection, isTypingTarget, event/combo → signature,
                          platform-aware formatting, conflict detection
  editorKeybinds.ts     — EDITOR_KEYBINDS: the declarative default map + commands
  keybindRegistry.ts    — dispatch index (sig → binding), context resolution,
                          conflict report, help grouping
  useEditorKeybinds.ts  — the single window keydown/keyup/blur listener + history coalescing
  index.ts              — public surface
components/KeybindHelpOverlay.tsx  — the `?` cheat-sheet (reads the registry)
```

`EditorLayout` mounts exactly one `useEditorKeybinds(enabled, api)`. Everything
else (pointer gestures, wheel zoom, pen Esc/Enter, inline text editing) stays in
the canvas — the hook never re-implements pointer logic.

### `Mod` = Ctrl / Cmd

Every binding is written once with `Mod`. At match time Ctrl and Cmd collapse
into one `mod` flag; at display time `Mod` renders as `⌘` on macOS and `Ctrl`
elsewhere (`Alt`→`⌥`, `Shift`→`⇧`). See `formatCombo` / `IS_MAC`.

### Layout-stable matching

Main keys come from `KeyboardEvent.code` (e.g. `KeyV`→`v`, `Digit1`→`1`,
`BracketRight`→`]`), so `Shift+1` and `Shift+=` never mutate into `!`/`+`. Named
keys (`ArrowUp`, `Enter`, `Escape`, `Space`) fall back to `KeyboardEvent.key`.
Authored combos use `=`/`-`/`[`/`]`/`/` tokens (never `+`); `?` is authored as
`Shift+/`.

## Shortcut map

### Tools (`tools`)

| Key | Action | Inspiration | Notes |
|-----|--------|-------------|-------|
| `V` | Move / Select | Figma | |
| `C` | Crop | Figma + Snagit | Opens a modal crop session on the page frame (ADR 0019); `Enter` applies, `Esc` cancels. |
| `A` | Arrow | Clippity | Illustrator's "Direct Select" — Clippity has no point-edit tool, so `A` keeps the existing Arrow tool. |
| `P` | Pen | Illustrator | |
| `T` | Text | Figma + Illustrator | |
| `R` | Rectangle | Figma | (Illustrator uses `M`; Clippity follows Figma's `R`.) |
| `O` | Ellipse | Figma | |
| `L` | Line | Figma | |
| `F` | Frame | Figma | |
| `B` | Blur | Clippity | |
| `M` | Measure | Clippity | Illustrator's `M` is its rectangle, which Clippity binds to `R` (Figma's letter) — so `M` was free for the dimension tool (ADR 0024). |
| `I` | Image | Clippity | Illustrator's "Eyedropper" — Clippity has no global eyedropper tool (color sampling lives in the color popover), so `I` keeps the existing Image tool. |
| `H` | Hand / Pan | Illustrator | |
| `Space` (hold) | Temporary Pan | Figma + Illustrator | Pans without changing the active tool; restores it on release. |
| `Esc` | Cancel / deselect | Common | Cancels an open crop, then closes the color editor / context menu / help, then deselects. |
| `Enter` | Apply crop | Figma + Snagit | Only while a crop session is open (`editor` context). With a text node selected and no crop, `Enter` still enters text editing (`selection` context wins). |

Tool letters only switch to tools available in the **current mode** (Annotate vs
Design — Workstream M). `B`/highlight/step/etc. are Annotate-only; `P`/`F`/image
are Design-only.

> Not bound: `Z` (no zoom tool — `Mod+Z` is Undo). See **Known limitations**.
> (`C` was unbound until the crop tool shipped; `M` until Measure did.)
>
> **The single-letter map is now full.** Stamps (ADR 0025) shipped without a
> shortcut for that reason, joining pixelate / magnify / highlight / step /
> callout / spotlight on the annotate submenu only. Any future tool wanting a
> key needs either a modifier combination or a decision to re-letter something.

### Selection / Editing (`selection`, `editing`)

| Key | Action | Inspiration |
|-----|--------|-------------|
| `Mod+A` | Select all | Common |
| `Mod+Shift+A` | Deselect all | Illustrator |
| `Delete` / `Backspace` | Delete selection | Common |
| `↑ ↓ ← →` | Nudge 1px | Illustrator |
| `Shift + ↑↓←→` | Nudge 10px | Illustrator |
| `Mod+D` | Duplicate | Figma |
| `Mod+C` / `Mod+X` / `Mod+V` | Copy / Cut / Paste (objects) | Common |
| `Mod+Z` | Undo | Common |
| `Mod+Shift+Z` / `Mod+Y` | Redo | Common |
| `Enter` | Edit text (when a text node is selected) | Figma |
| `Alt`-drag | Duplicate while dragging | Illustrator/Figma |

Nudges coalesce: a held burst of arrow presses is **one** undo step (a single
`begin/endHistory` transaction closed after a short idle gap). Pasted/duplicated
objects offset by 24px so they read as distinct.

### Layers (`layers`)

| Key | Action | Inspiration |
|-----|--------|-------------|
| `Mod+]` | Bring forward | Figma/Illustrator |
| `Mod+Shift+]` | Bring to front | Figma/Illustrator |
| `Mod+[` | Send backward | Figma/Illustrator |
| `Mod+Shift+[` | Send to back | Figma/Illustrator |
| `Mod+Alt+]` / `Mod+Alt+[` | Bring forward / Send backward (alias) | Illustrator |
| `Mod+L` | Lock / unlock selection | Clippity |
| `Mod+Shift+L` | Hide / show selection | Clippity |
| `Mod+G` / `Mod+Shift+G` | Group / Ungroup | Figma/Illustrator |

Lock/hide toggle the whole selection in one undo step (lock only if any are
unlocked; show only if all are hidden). Hidden + locked nodes are not selectable
from the canvas (they remain reachable from the layers tree).

**Group** wraps the top-level selection in a new non-clipping `Group` frame
(the scene's only container type), preserving paint order and z-position;
**Ungroup** dissolves every selected frame back into its slot. Because nodes
carry **absolute** coordinates and frames are pure logical containers, both are
a single tree restructure (one undo step) — no geometry is touched. See
`editorStore.group` / `ungroup`.

### View (`view`)

| Key | Action | Inspiration |
|-----|--------|-------------|
| `Shift+=` / `Mod+=` | Zoom in (`+`) | Figma / common |
| `Shift+-` / `Mod+-` | Zoom out (`−`) | Figma / common |
| `Shift+1` / `Mod+0` | Zoom to fit | Figma |
| `Shift+2` | Zoom to selection | Figma |
| `Mod+1` | Zoom to 100% | Common |
| `Space`-drag | Pan canvas | Figma/Illustrator |
| `?` (`Shift+/`) | Show this help | Common |

`Shift+2` is a no-op (non-blocking) when nothing is selected. Wheel/trackpad
zoom + pan are unchanged.

### Transform / Resize (`transform`)

These are **drag gestures** plus a few keyboard nudges:

| Gesture | Action | Inspiration |
|---------|--------|-------------|
| `Shift` + drag corner handle | Preserve aspect ratio | Figma + Illustrator |
| `Alt` + drag handle | Resize from center | Illustrator/Figma |
| `Shift+Alt` + drag handle | Preserve ratio from center | Illustrator/Figma |
| `Shift` + drag **side** handle | Expand the other axis to hold the ratio | Figma |
| `Mod+Shift+→ / ←` | Resize width ±1px | Clippity |
| `Mod+Shift+↓ / ↑` | Resize height ±1px | Clippity |
| `Mod+Shift+Alt+→ / ←` | Resize ±1px proportionally | Clippity |

Modifiers are read **live** every pointer-move, so pressing/releasing `Shift` or
`Alt` mid-drag flips the behavior immediately. A whole drag is one undo step;
keyboard resize bursts coalesce like nudges. During a proportional resize the
transform readout shows a small lock glyph (`TransformHud.aspectLocked`).

#### Aspect-ratio math

```
ratio = originalWidth / originalHeight   // newWidth / newHeight must equal ratio
```

The dominant axis drives the other (corner + driven-side handles compute the
opposite dimension from the dragged one). Sizes clamp to `MIN_SIZE` (no flip).
Center resize keeps the frame center fixed; with `Shift+Alt` the center stays put
**and** the ratio holds. See `geometry.ts::resizeFrame` (`keepAspect`,
`fromCenter`).

#### Object types that support proportional / center resize

All **box-like** nodes: images, rectangles, ellipses, frames, text boxes,
polygons, stars, paths (pen/pencil), and the annotation regions built on boxes —
**blur, pixelate, magnifier, highlight, step, callout**. Multi-selected
box nodes resize together via the keyboard nudges.

**Line-like** nodes (line, arrow) use endpoint handles, not the 8-handle box
transform, so aspect-ratio/center resize doesn't apply — drag an endpoint
(`Shift` constrains the angle). Keyboard resize nudges skip line-like + locked
nodes.

### Inspector ratio lock

The Design-mode **Layout** panel (`LayoutSection`) has linked `W`/`H` fields with
an aspect-lock toggle (`node.lockAspect`). When locked, editing one dimension
recalculates the other, and **canvas drags honor it without holding `Shift`**.
The lock state persists per node for the session.

### File / Export (`file`)

| Key | Action | Inspiration |
|-----|--------|-------------|
| `Mod+E` | Export PNG | Clippity |
| `Mod+Shift+E` | Export options (reveals the Export tab) | Clippity |
| `Mod+Shift+C` | Copy the flattened image to the clipboard | Capture-tool |
| `Mod+S` / `Mod+Shift+S` | Save the editable project | Common |
| `Mod+Enter` | Commit the active text edit | Common |
| `Esc` | Cancel the active text edit | Common |

**Save vs Export.** `Mod+E` exports a **flattened PNG** (a new capture).
`Mod+S` saves the **editable scene** so you can re-open the capture and keep
editing every annotation. The scene is written as a JSON sidecar
(`<captures>/.scenes/<file>.json`, hidden from the library) via
`editor_save_scene`; it's **self-contained** (image fills embed their data URI)
and **non-destructive** (the original capture file is untouched). Re-opening the
capture restores the saved scene automatically (`editorLoad` returns it in
`scene`); a missing/corrupt sidecar falls back to seeding from the flat image.
The document status pill reads **Draft → Edited → Saved**. (Save is also in the
document-title menu.) Save As currently behaves like Save — a path-picker is a
follow-up.

`Mod+E` / `Mod+Shift+C` reuse the same export pipeline (`useEditorExport`) as the
top-bar Export/Copy buttons.

### Text editing (`text`)

Inside the inline text editor (`<textarea>`): `Esc` cancels, `Mod+Enter` commits,
and plain `Enter` inserts a newline. The textarea owns its keys (it stops
propagation), so normal typing never triggers editor shortcuts.

Rich-text `Mod+B/I/U` are **not** bound — text nodes have no per-run styling (a
node carries one `fontWeight`/color), so there is nothing to toggle on a
selection range. Documented as a limitation, not faked.

## Contexts & priority

A binding declares a `context`; dispatch resolves the highest-priority **active**
one, so a single key fires at most one command:

```
textEditing > selection > editor
```

- `editor` (default) — active when the editor owns the keyboard and the user
  isn't typing.
- `selection` — additionally requires ≥1 selected node (e.g. Delete, nudge,
  z-order, lock/hide).
- `textEditing` — reserved; the inline editor currently owns its own keys.

A key may appear in two contexts on purpose (e.g. an `editor` default + a
`selection` override) — that is layering, not a conflict.

## Typing protection

`isTypingTarget` suppresses tool/editing shortcuts while focus is in an
`<input>`, `<textarea>`, `<select>`, `contenteditable`, or an element with
`role=textbox|searchbox|spinbutton` — covering rename fields, the panel number
fields, color inputs, and the help filter. Exceptions: the inline text editor
handles its own `Esc`/`Mod+Enter`, and the help overlay handles its own `Esc`.

## Conflict detection

`findKeybindConflicts` flags two non-hidden bindings that share a signature in
the **same** context (a true ambiguity). The registry runs it at load and
`console.warn`s in dev; `EDITOR_KEYBIND_CONFLICTS` is asserted empty in tests.
`preventDefault` is only called when a binding actually handles the event.

## Adding a shortcut

Append to `EDITOR_KEYBINDS` in `editorKeybinds.ts`:

```ts
{
  id: "my-action",            // stable, unique
  label: "My action",         // shown in the help overlay
  category: "editing",        // help grouping
  keys: ["Mod+J"],            // one or more combos; `Mod` = Ctrl/Cmd
  context: "selection",       // default "editor"
  // allowWhileTyping, preventDefault (default true), coalesce, hidden, helpKeys, note
  onKeyDown: ({ store, event, api }) => store.doSomething(),
  onKeyUp: ({ store }) => {},  // optional (e.g. temp-pan release)
}
```

- Commands receive `{ store, event, api }`. `store` is `useEditorStore.getState()`
  (call actions on it); `api` covers React-bound effects (export/clipboard/help).
- Set `coalesce: true` for repeat-friendly bursts (nudge/resize) to fold into one
  undo step.
- Multi-combo bindings (e.g. the four arrows) disambiguate via `event` in the
  command.
- Run the tests — `keybindRegistry.test.ts` will fail if you introduce a
  conflict.

## Known limitations & future work

- **Grouping** uses the frame node as the group container (there is no separate
  `group` type). Ungroup therefore dissolves **any** selected frame — including a
  frame the user drew deliberately — back into its parent. A distinct group node
  type (so frames and groups can diverge) is a possible follow-up.
- **Save** persists the editable scene as a JSON sidecar and re-opens it, but
  does **not** update the library's preview thumbnail (the original capture PNG
  is left untouched). Re-flattening the preview on save, and a Save-As path
  picker, are follow-ups. The scene embeds the base image, so a saved project is
  portable but larger than the PNG.
- **No eyedropper/zoom tool** — `I`/`Z` keep their existing meanings (Image /
  Undo-modifier). Add the tools first, then the letters. (`C` followed that
  rule: it stayed unbound until the crop tool shipped, then took the letter.)
- **Rich-text `Mod+B/I/U`** — unsupported until text nodes carry styled runs.
- **`Alt`-drag duplicate** is implemented in the canvas move gesture; there is no
  separate keyboard binding (it's a drag modifier).
- **Layout (non-US keyboards):** matching keys off `KeyboardEvent.code` is
  layout-stable for letters/digits/brackets on standard layouts; exotic layouts
  may map punctuation differently.
- **User-customizable keybinds:** the registry is declarative and
  conflict-checked, which is the groundwork. A settings UI that overrides
  `keys[]` per `id` (persisted, re-validated with `findKeybindConflicts`) is the
  natural next step.
