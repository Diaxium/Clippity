import { ClipboardPaste, Copy, Scissors, TextCursorInput } from "lucide-react";

import {
  asTextField,
  copyField,
  cutField,
  fieldHasSelection,
  fieldIsEditable,
  pasteIntoField,
  selectAllInField,
  snapshotField,
} from "./textFieldCommands";
import type { ContextMenuEntry, ContextMenuField } from "./types";

/**
 * The menu for a right-click no feature claimed.
 *
 * Two cases are worth answering and the rest deliberately are not:
 *
 *  - **A text field.** Cut / Copy / Paste / Select all. Every settings
 *    input, the library search box, the editor's numeric fields — these
 *    are the places where losing the native menu would actually be felt,
 *    and no feature is going to hand-wire clipboard commands onto each
 *    one.
 *  - **Selected text.** Copy, so a filename or an error message in the
 *    toast can still be lifted out.
 *
 * Everything else gets *no* menu. Right-clicking dead chrome and being
 * offered a list of commands that have nothing to do with what is under
 * the cursor is worse than nothing — surfaces with real actions register
 * them through `useContextMenu`. The native menu is already suppressed
 * by then, so "no menu" here means nothing happens, not a WebView2 popup.
 */
export function fallbackEntries(target: EventTarget | null): {
  entries: ContextMenuEntry[];
  field?: ContextMenuField;
} {
  const el = asTextField(target);
  if (el) {
    const field = snapshotField(el);
    return { entries: textFieldEntries(field), field };
  }

  const selection = window.getSelection?.()?.toString() ?? "";
  if (selection.trim()) {
    return {
      entries: [
        {
          id: "copy-selection",
          label: "Copy",
          shortcut: "Ctrl C",
          icon: Copy,
          onSelect: () => {
            void navigator.clipboard?.writeText(selection).catch(() => {});
          },
        },
      ],
    };
  }

  return { entries: [] };
}

function textFieldEntries(field: ContextMenuField): ContextMenuEntry[] {
  const editable = fieldIsEditable(field);
  const hasSelection = fieldHasSelection(field);

  return [
    {
      id: "cut",
      label: "Cut",
      shortcut: "Ctrl X",
      icon: Scissors,
      disabled: !editable || !hasSelection,
      onSelect: () => cutField(field),
    },
    {
      id: "copy",
      label: "Copy",
      shortcut: "Ctrl C",
      icon: Copy,
      disabled: !hasSelection,
      onSelect: () => copyField(field),
    },
    {
      id: "paste",
      label: "Paste",
      shortcut: "Ctrl V",
      icon: ClipboardPaste,
      // Left enabled unconditionally: knowing whether the clipboard holds
      // text needs an async read, and greying out a Paste that would in
      // fact have worked is the worse failure.
      disabled: !editable,
      onSelect: () => void pasteIntoField(field),
    },
    "divider",
    {
      id: "select-all",
      label: "Select all",
      shortcut: "Ctrl A",
      icon: TextCursorInput,
      disabled: field.el.value.length === 0,
      onSelect: () => selectAllInField(field),
    },
  ];
}
