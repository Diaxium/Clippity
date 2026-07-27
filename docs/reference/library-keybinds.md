# Library selection & keyboard shortcuts

The library's selection model, and the four keys that drive it. The
editor's map is documented separately in
[editor-keybinds.md](editor-keybinds.md) — where the two overlap they
agree deliberately, because one app should not have two answers for what
`Esc` means.

## Focus is not selection

The library holds two pointers at a capture and they mean different
things:

- **Focus** (`focusedId`) — *"let me look at this one."* Drives the
  inspector. One at a time. Drawn as an accent frame + tint.
- **Selection** (`selected[]`) — *"these are the ones I'm about to act
  on."* Drives the bulk bar. Many at a time, kept **in the order the user
  picked them**, because "add to collection" appends in that order. Drawn
  as an accent border, no tint.

They overlap constantly, which is exactly why they are drawn differently:
conflating them would leave the user unable to tell which captures "Move
to trash" is about to take.

**A plain click focuses and does not select.** That is load-bearing —
selection stays opt-in, so the bulk bar never appears just because
somebody was browsing, and there is no "selection mode" to enter or
leave.

## The click ladder

Owned in one place, `hooks/useCaptureClick.ts`, and shared by the grid
card and the list row.

| Gesture | Meaning |
|---------|---------|
| Click | Focus it (inspector). No selection. |
| `Mod`-click | Toggle this one in the selection; it becomes the anchor. |
| `Shift`-click | Select the run from the anchor to here, replacing the selection. |
| `Mod+Shift`-click | Add that run to what is already selected. |
| Double-click | Open it (editor, palette view, or a clipboard write — see `CaptureCard`). |
| Click the checkbox | Toggle, without focusing. |

`Mod` is Ctrl on Windows/Linux, ⌘ on macOS.

### The anchor

`anchorId` is the pivot a Shift-click ranges from: **the last capture the
user pointed at, by either gesture.** Both a plain click (which only
focuses) and a Ctrl-click (which doesn't move the inspector) set it, so
neither pointer alone could serve — hence a third field.

Three rules make the gesture behave the way a file manager does:

1. **The pivot falls back to `focusedId`.** A plain click doesn't select,
   so without this the very first "click one, Shift-click another" would
   have nothing to range from. This is what makes the gesture work from a
   cold start, which is the case it exists for.
2. **The run is stored in screen order**, not anchor-outward order. The
   selection list is ordered and that order is user-visible downstream; a
   user who Shift-clicked *upward* was pointing at a block, not asking
   for a reversed one.
3. **The pivot is pinned after a range.** Successive Shift-clicks widen
   and narrow the same run instead of walking the anchor along behind the
   cursor.

Ranges are resolved against `visibleIds` — the render order of what is on
screen, flattened across day sections and mirrored into the store by
`LibraryLayout` (the only component that knows it, since that is where
the day grouping, the sort, and a collection's curated order are finally
reconciled). A range whose anchor has since been filtered away degrades
to selecting just the target.

## Shortcuts

| Key | Action | Live when |
|-----|--------|-----------|
| `Mod+A` | Select all | always |
| `Mod+Shift+A` | Deselect all | ≥1 selected |
| `Esc` | Clear the selection | ≥1 selected |
| `Delete` / `Backspace` | Move the selection to the trash | ≥1 selected |
| `Mod+K` | Focus the search box | always (owned by `LibraryTopBar`) |

**Select all means everything on screen**, not everything on disk. The
grid is filtered, searched and scoped; a Select All that reached past the
filter would hand the bulk bar captures the user cannot see.

**`Esc` does not `preventDefault`.** It is the shared "back out of it"
key — the search box and the popovers listen for it too — so clearing the
selection must not swallow it.

**`Delete` is inert in Trash mode.** The only delete left there is
`purge`, which is irreversible and has no undo. A key that destroys forty
files on a keystroke, sitting under the finger that was just clearing a
selection, is not a shortcut worth having; purge stays a button you have
to aim at.

## Architecture

```
features/library/
  keybinds/
    libraryKeybinds.ts     — LibraryKeybind, the map, dispatch index, conflict check
    useLibraryKeybinds.ts  — the single window keydown listener
    index.ts               — public surface
  hooks/useCaptureClick.ts — the click/modifier ladder, shared by card + row
  state/libraryStore.ts    — selected[], anchorId, visibleIds, selectRange, selectAll
```

`LibraryLayout` mounts exactly one `useLibraryKeybinds(enabled, api)`, the
way `EditorLayout` mounts `useEditorKeybinds`. The two views are never
mounted at once (the dashboard renders one), so their `Mod+A` bindings
cannot both fire.

This is the editor's pattern at the scale the library needs. The editor
splits types / registry / commands across four files because it carries
~50 bindings over three contexts; the library has four, so they share one
file. The shape is deliberately the same, so folding both into a shared
registry later is a move rather than a rewrite.

### Contexts

`selection` (needs ≥1 selected) beats `library` (always live) for the
same key, so one event fires at most one command. Typing protection
suppresses everything while focus is in an input, textarea, or
contenteditable — in the search box, `Mod+A` means "select this text".

### Shared matching primitives

The layout-stable key matching (`comboSigKey`, `eventSigKey`,
`isTypingTarget`) is imported from `features/editor/keybinds/keybindUtils`
rather than re-derived. Those functions are pure and carry no editor
state; a second copy would be a second set of rules for what `Mod+A`
means in one app. Their natural home is `shared/` — that import is the
standing note that they should move there once a third caller appears.

## Known gaps

- **No arrow-key navigation.** Focus can't be walked across the grid from
  the keyboard, so `Shift`-ranging is a mouse gesture only. This needs a
  roving tabindex plus a runtime read of the `auto-fill` column count
  (the grid's width depends on the rail and inspector, not the viewport).
- **No discoverability surface.** The bindings are declarative and could
  generate a `?` overlay the way the editor's do, but nothing renders one
  yet; the right-click menu on the grid background is currently the only
  place `Ctrl A` is advertised.
- **The selection is not pruned when the grid narrows.** Filtering or
  searching away a selected capture leaves it in `selected[]`, so the bulk
  bar can read "5 selected" while acting on the 2 still on screen.
- **No select-all-in-section** on a day heading.
