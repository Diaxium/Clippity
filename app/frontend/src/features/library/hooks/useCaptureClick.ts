/**
 * The one place the library decides what a click on a capture means.
 *
 * Cards and rows are two renderings of the same object with the same
 * interaction contract, so the modifier ladder lives here rather than
 * being written twice and drifting apart the first time one of them
 * gains a gesture.
 *
 * The ladder, most specific first:
 *
 * | Gesture              | Meaning                                    |
 * |----------------------|--------------------------------------------|
 * | `Shift`-click        | Select the run from the anchor to here      |
 * | `Mod+Shift`-click    | Add that run to what's already selected     |
 * | `Mod`-click          | Toggle this one; it becomes the anchor      |
 * | click                | Focus it (inspector) — **no** selection     |
 *
 * A plain click still refuses to select, which is the load-bearing part
 * of the design: selection is opt-in, so the bulk bar never appears
 * because someone was browsing. Shift-click reaches back to the focused
 * capture for its pivot ({@link useLibraryStore.selectRange}), so the
 * gesture works from a plain click anyway — the user gets the file-manager
 * behavior without the library growing a selection they didn't ask for.
 */

import { useCallback, useMemo } from "react";
import type { MouseEvent } from "react";

import { useLibraryStore } from "../state/libraryStore";
import type { CaptureMeta } from "../types";

export function useCaptureClick(
  meta: CaptureMeta,
  onFocus: (m: CaptureMeta) => void
) {
  const toggleSelected = useLibraryStore((s) => s.toggleSelected);
  const selectRange = useLibraryStore((s) => s.selectRange);

  const onClick = useCallback(
    (e: MouseEvent) => {
      if (e.shiftKey) {
        selectRange(meta.id, e.ctrlKey || e.metaKey);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        toggleSelected(meta.id);
        return;
      }
      onFocus(meta);
    },
    [meta, onFocus, selectRange, toggleSelected]
  );

  // A Shift-click inside a grid is also the browser's "extend the text
  // selection" gesture, which paints a blue smear across every card title
  // between the two. The selection starts on mousedown, so that is where
  // it has to be refused — by the time the click lands it already exists.
  const onMouseDown = useCallback((e: MouseEvent) => {
    if (e.shiftKey) e.preventDefault();
  }, []);

  return useMemo(() => ({ onClick, onMouseDown }), [onClick, onMouseDown]);
}
