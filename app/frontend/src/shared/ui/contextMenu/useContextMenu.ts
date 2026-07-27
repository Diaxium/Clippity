import { useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useContextMenuStore } from "./contextMenuStore";
import type { ContextMenuEntry } from "./types";

/**
 * Attach an app menu to a region.
 *
 * ```tsx
 * const onContextMenu = useContextMenu(() => captureMenuEntries(meta, …));
 * return <article onContextMenu={onContextMenu}>…</article>;
 * ```
 *
 * The builder runs at click time, not render time, so entries can read
 * live state (clipboard contents, selection size) without the region
 * re-rendering to keep them honest. Returning `null` — or an empty list —
 * means "this region has no menu", and the event is left alone so an
 * ancestor region, or the global text-field fallback, can answer instead.
 *
 * Handled events stop propagating. That is what keeps a card's menu from
 * also triggering the grid's, and what tells the window-level fallback in
 * `useNativeContextMenu` that this click already found an owner.
 */
export function useContextMenu(
  build: (e: ReactMouseEvent) => ContextMenuEntry[] | null,
  label?: string
) {
  const open = useContextMenuStore((s) => s.open);

  return useCallback(
    (e: ReactMouseEvent) => {
      const entries = build(e);
      if (!entries || entries.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      open({ x: e.clientX, y: e.clientY, entries, label });
    },
    [build, label, open]
  );
}
