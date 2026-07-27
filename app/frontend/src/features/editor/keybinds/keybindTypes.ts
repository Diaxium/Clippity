/**
 * Editor keybind model — pure types, no React, no store coupling beyond the
 * `EditorState` action surface a command drives. The declarative registry
 * ({@link ./editorKeybinds}) is a list of {@link EditorKeybind}; the hook
 * ({@link ./useEditorKeybinds}) resolves an event to at most one binding and
 * runs its command with a {@link CommandCtx}.
 *
 * Design goals (Figma + Illustrator hybrid):
 *  - Declarative registration with categories + contexts.
 *  - Platform-aware modifiers via the `Mod` abstraction (Ctrl ⇄ Cmd).
 *  - Keydown + keyup bindings (temporary tools), typing protection,
 *    conflict detection, and a help overlay — all reading the same list.
 */

import type { EditorState } from "../state/editorStore";

/** Help-overlay grouping (mirrors the task's section taxonomy). */
export type KeybindCategory =
  | "tools"
  | "selection"
  | "editing"
  | "layers"
  | "view"
  | "transform"
  | "text"
  | "file";

/**
 * Where a binding is live. Dispatch resolves the highest-priority *active*
 * context for a given key, so a single key event fires at most one command:
 *
 *   textEditing > selection > editor
 *
 * `editor` (the default) is active whenever the editor owns the keyboard and the
 * user isn't typing; `selection` additionally requires ≥1 selected node;
 * `textEditing` is reserved for the inline text editor (which today owns its own
 * keys, so no registry binding uses it yet — kept for forward-compat).
 */
export type KeybindContext = "editor" | "selection" | "textEditing";

/**
 * React-bound side effects a pure store action can't perform (flatten/export to
 * a PNG, copy to the system clipboard, reveal the export panel). Injected into
 * every command so the registry itself stays free of hooks.
 */
export interface KeybindApi {
  /** Flatten the scene to a PNG and persist it (Mod+E). */
  exportImage(): void;
  /** Reveal the inspector's Export tab / options (Mod+Shift+E). */
  exportOptions(): void;
  /** Save the project — surfaces a non-blocking "not yet" message (Mod+S). */
  saveDocument(): void;
  /** Copy the flattened final image to the clipboard (Mod+Shift+C). */
  copyFlattened(): void;
  /** Toggle the keyboard-shortcuts help overlay (`?`). */
  toggleHelp(): void;
}

export interface CommandCtx {
  /** Live store actions + state snapshot (`useEditorStore.getState()`). Actions
   *  read fresh state internally, so the snapshot is safe to hold. */
  store: EditorState;
  /**
   * The originating keyboard event (read `key`/modifiers, call preventDefault).
   * Absent when the command is invoked from a non-keyboard surface such as the
   * command palette — commands that need it must degrade to a no-op rather than
   * assume a synthetic event (see `paletteHidden`).
   */
  event?: KeyboardEvent;
  /** React-bound side effects (export / clipboard / help). */
  api: KeybindApi;
}

export type EditorCommand = (ctx: CommandCtx) => void;

export interface EditorKeybind {
  /** Stable id (used by tests, conflict reports, and as a React key). */
  id: string;
  /** Human label for the help overlay. */
  label: string;
  category: KeybindCategory;
  /**
   * One or more combos that trigger this binding, e.g. `"Mod+D"`, `"Shift+1"`,
   * `"ArrowUp"`, `"V"`. Use `Mod` for Ctrl/Cmd. Multi-combo bindings (e.g. the
   * four arrow keys) let one command disambiguate via {@link CommandCtx.event}.
   */
  keys: string[];
  /** Where the binding is live (default `"editor"`). */
  context?: KeybindContext;
  /** Fire even while typing in an input/textarea (default `false`). */
  allowWhileTyping?: boolean;
  /** Call `preventDefault()` when handled (default `true`). */
  preventDefault?: boolean;
  /** Open/extend a single coalesced history transaction around the command, so
   *  a burst of repeats (held arrow nudge/resize) is one undo step. */
  coalesce?: boolean;
  onKeyDown?: EditorCommand;
  onKeyUp?: EditorCommand;
  /** Hide from the help overlay (aliases / internal duplicates). Also hides the
   *  binding from the command palette — an alias is not a distinct command. */
  hidden?: boolean;
  /**
   * Hide from the command palette while staying in the help overlay. For
   * bindings that only make sense from a key event: either they read
   * {@link CommandCtx.event} to disambiguate a multi-combo binding (the arrow
   * nudge/resize family), or they model a held key (`onKeyUp`). Set it
   * explicitly — do not infer it from `keys.length`, which is only
   * accidentally correlated.
   */
  paletteHidden?: boolean;
  /** Pre-formatted chip labels for the help overlay; falls back to the first
   *  combo's platform-aware formatting when absent. */
  helpKeys?: string[];
  /** Small trailing note in the help overlay (e.g. "Coming soon"). */
  note?: string;
}
