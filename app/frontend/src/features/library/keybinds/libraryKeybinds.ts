/**
 * The library's keyboard map — declarative, conflict-checked, and small.
 *
 * This is the editor's keybind pattern ([docs/editor-keybinds.md](../../../../../docs/editor-keybinds.md))
 * at the scale the library actually needs. The editor splits types /
 * registry / commands across four files because it carries ~50 bindings
 * over three contexts; the library has four, so they live in one file and
 * the "registry" is a lookup built at module load. The shape is
 * deliberately the same, so folding this into a shared registry later is
 * a move, not a rewrite.
 *
 * The matching primitives are imported from the editor rather than
 * re-derived. They are pure and carry no editor state — layout-stable
 * `KeyboardEvent.code` tokens, Ctrl⇄Cmd collapsed into one `Mod` flag,
 * and typing-surface detection — and a second copy would be a second set
 * of rules for what `Mod+A` means in the same app. Their natural home is
 * `shared/`; this import is what says so.
 *
 * ### The map
 *
 * | Key | Action | Context |
 * |-----|--------|---------|
 * | `Mod+A` | Select every capture on screen | library |
 * | `Mod+Shift+A` | Deselect all | selection |
 * | `Esc` | Clear the selection | selection |
 * | `Delete` / `Backspace` | Move the selection to the trash | selection |
 *
 * `Mod+A` / `Mod+Shift+A` / `Esc` / `Delete` are the same four keys the
 * editor binds to the same four meanings, which is the point: the two
 * views of one app should not disagree about what Escape does.
 */

import {
  comboSigKey,
  eventSigKey,
  isTypingTarget,
} from "@features/editor/keybinds/keybindUtils";
import {
  applyOverrides,
  getKeybindOverrides,
  keybindOverridesVersion,
} from "@shared/keybinds/overrides";

import type { LibraryStoreState } from "../state/libraryStore";

/**
 * Where a binding is live. `selection` additionally requires ≥1 selected
 * capture and wins over `library` for the same key, so `Esc` clears a
 * selection when there is one and otherwise falls through to whatever
 * else is listening (a popover, the search box).
 */
export type LibraryKeybindContext = "library" | "selection";

/** Effects a store action can't perform — they need the list the layout
 *  holds, or the IPC fan-out it owns. */
export interface LibraryKeybindApi {
  /** Move the current selection to the trash. A no-op in Trash mode —
   *  see the binding's note. */
  trashSelection(): void;
}

export interface LibraryCommandCtx {
  /** Live store snapshot + actions (`useLibraryStore.getState()`). */
  store: LibraryStoreState;
  event: KeyboardEvent;
  api: LibraryKeybindApi;
}

export interface LibraryKeybind {
  id: string;
  label: string;
  keys: string[];
  context?: LibraryKeybindContext;
  /** Call `preventDefault()` when handled (default `true`). */
  preventDefault?: boolean;
  onKeyDown(ctx: LibraryCommandCtx): void;
}

export const LIBRARY_KEYBINDS: readonly LibraryKeybind[] = [
  {
    id: "select-all",
    label: "Select all",
    keys: ["Mod+A"],
    // Everything *on screen*, not everything in the library: the grid is
    // filtered, searched and scoped, and a Select All that reached past
    // the filter would hand the bulk bar captures the user can't see.
    onKeyDown: ({ store }) => store.selectAll(),
  },
  {
    id: "deselect-all",
    label: "Deselect all",
    keys: ["Mod+Shift+A"],
    context: "selection",
    onKeyDown: ({ store }) => store.clearSelection(),
  },
  {
    id: "clear-selection",
    label: "Clear selection",
    keys: ["Escape"],
    context: "selection",
    // Not preventDefault: Escape is a shared "back out of it" key, and
    // swallowing it here would strand any surface that also wants it.
    // Clearing the selection is the outermost meaning, so it runs last in
    // spirit — the popovers that care listen on `document` and close on
    // the same event.
    preventDefault: false,
    onKeyDown: ({ store }) => store.clearSelection(),
  },
  {
    id: "trash-selection",
    label: "Move selection to trash",
    keys: ["Delete", "Backspace"],
    context: "selection",
    // In Trash mode this is deliberately inert. The only delete left
    // there is `purge`, which is irreversible and has no undo — and a
    // key that destroys forty files on a keystroke, sitting under the
    // finger that was just clearing a selection, is not a shortcut worth
    // having. Purge stays a button you have to aim at.
    onKeyDown: ({ api }) => api.trashSelection(),
  },
];

/** Runtime gating, derived from the store by the hook. */
export interface LibraryDispatchState {
  /** Focus is in an input / textarea / contenteditable. */
  typing: boolean;
  hasSelection: boolean;
}

const CONTEXT_PRIORITY: Record<LibraryKeybindContext, number> = {
  selection: 2,
  library: 1,
};

function contextOf(kb: LibraryKeybind): LibraryKeybindContext {
  return kb.context ?? "library";
}

function isActive(kb: LibraryKeybind, st: LibraryDispatchState): boolean {
  if (st.typing) return false;
  return contextOf(kb) === "selection" ? st.hasSelection : true;
}

function buildIndex(
  list: readonly LibraryKeybind[]
): Map<string, LibraryKeybind[]> {
  const index = new Map<string, LibraryKeybind[]>();
  for (const kb of list) {
    for (const combo of kb.keys) {
      const sig = comboSigKey(combo);
      const bucket = index.get(sig);
      if (bucket) bucket.push(kb);
      else index.set(sig, [kb]);
    }
  }
  return index;
}

// Memoized on the override version so the index only rebuilds when the
// user actually remaps a library key — not on every keystroke.
let cachedVersion = -1;
let effectiveList: readonly LibraryKeybind[] = LIBRARY_KEYBINDS;
let keydownIndex = buildIndex(LIBRARY_KEYBINDS);

function ensureEffective(): void {
  const version = keybindOverridesVersion();
  if (version === cachedVersion && cachedVersion !== -1) return;
  effectiveList = applyOverrides(
    "library",
    LIBRARY_KEYBINDS,
    getKeybindOverrides()
  );
  keydownIndex = buildIndex(effectiveList);
  cachedVersion = version;
}

/** The default library map with user overrides applied — what the help
 *  surface / settings panel read. */
export function effectiveLibraryKeybinds(): readonly LibraryKeybind[] {
  ensureEffective();
  return effectiveList;
}

/** The highest-priority *active* binding for this event, or null. One
 *  event fires at most one command. */
export function resolveLibraryKeyDown(
  e: KeyboardEvent,
  st: LibraryDispatchState
): LibraryKeybind | null {
  ensureEffective();
  const candidates = keydownIndex.get(eventSigKey(e));
  if (!candidates) return null;
  let best: LibraryKeybind | null = null;
  let bestPriority = -1;
  for (const kb of candidates) {
    if (!isActive(kb, st)) continue;
    const priority = CONTEXT_PRIORITY[contextOf(kb)];
    if (priority > bestPriority) {
      best = kb;
      bestPriority = priority;
    }
  }
  return best;
}

/** Two bindings sharing a signature *in the same context* — a real
 *  ambiguity. Asserted empty in tests. */
export function findLibraryKeybindConflicts(): string[] {
  const seen = new Map<string, string[]>();
  for (const kb of LIBRARY_KEYBINDS) {
    for (const combo of kb.keys) {
      const bucket = `${contextOf(kb)}|${comboSigKey(combo)}`;
      const ids = seen.get(bucket);
      if (ids) ids.push(kb.id);
      else seen.set(bucket, [kb.id]);
    }
  }
  return [...seen.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([bucket, ids]) => `${bucket}: ${ids.join(", ")}`);
}

export { isTypingTarget };
