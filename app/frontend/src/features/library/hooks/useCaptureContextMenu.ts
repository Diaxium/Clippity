import { useCallback } from "react";

import { useContextMenu } from "@shared/ui/contextMenu";

import {
  captureActionEntries,
  type CaptureActionHandlers,
} from "../lib/captureActions";
import type { CaptureMeta, LibraryMode } from "../types";

interface Options extends CaptureActionHandlers {
  /** Right-clicking a capture focuses it first — see below. */
  onFocus: (m: CaptureMeta) => void;
}

/**
 * Right-click menu for a capture, shared by the grid card and the list
 * row so both offer the same commands.
 *
 * The click focuses the capture before opening. That matches every file
 * manager, and here it is load-bearing rather than cosmetic: the
 * inspector is the only thing on screen that names which capture the
 * commands are about, and a menu whose "Move to trash" refers to a card
 * the user never selected is how captures get deleted by accident.
 *
 * Focus, not selection: a multi-select the user built deliberately isn't
 * discarded just because they right-clicked one of its members.
 */
export function useCaptureContextMenu(
  meta: CaptureMeta,
  mode: LibraryMode,
  { onFocus, onDelete, onRestore, onPurge }: Options
) {
  return useContextMenu(
    useCallback(() => {
      onFocus(meta);
      return captureActionEntries(
        meta,
        mode,
        { onDelete, onRestore, onPurge },
        { includeFavorite: true }
      );
    }, [meta, mode, onFocus, onDelete, onRestore, onPurge]),
    `Actions for ${meta.title}`
  );
}
