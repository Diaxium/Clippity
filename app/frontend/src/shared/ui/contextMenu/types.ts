import type { ComponentType } from "react";

/** Icon shape every entry accepts — matches `lucide-react`'s props. */
export type ContextMenuIcon = ComponentType<{
  size?: number;
  strokeWidth?: number;
}>;

export interface ContextMenuAction {
  /** Stable key. Also what the tests and keyboard nav address entries by. */
  id: string;
  label: string;
  /** Right-aligned hint, e.g. `"Ctrl C"`. Purely cosmetic — the binding
   *  itself lives with the feature's keymap. */
  shortcut?: string;
  icon?: ContextMenuIcon;
  /** Destructive tint (delete / purge). */
  danger?: boolean;
  /** Rendered greyed and inert. Kept in the list rather than filtered out
   *  so the menu's shape stays stable — a person learns where "Paste" sits
   *  and it shouldn't move when the clipboard happens to be empty. */
  disabled?: boolean;
  onSelect: () => void;
}

/** `"divider"` matches the editor menu's existing vocabulary. */
export type ContextMenuEntry = "divider" | ContextMenuAction;

/**
 * A text field the menu was opened over, captured at open time.
 *
 * Clicking a menu item moves focus off the field and collapses its
 * selection, so the clipboard commands can't run against "whatever is
 * focused now" — they restore this snapshot first. See `restoreField`.
 */
export interface ContextMenuField {
  el: HTMLInputElement | HTMLTextAreaElement;
  start: number;
  end: number;
}

export interface OpenContextMenu {
  /** Viewport coordinates of the click. The host flips/clamps from here. */
  x: number;
  y: number;
  entries: ContextMenuEntry[];
  /** Accessible name for the menu, e.g. `"Actions for Screenshot 4"`. */
  label?: string;
  field?: ContextMenuField;
}
