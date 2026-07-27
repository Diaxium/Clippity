import { useMemo } from "react";

import { useEditorStore } from "../state/editorStore";
import type { SceneNode } from "../types";

/**
 * The selected nodes, primary first, with any dangling ids dropped.
 *
 * Every inspector section derived this the same way; hoisting it here means the
 * multi-select reads in `lib/multi` all start from one definition of "the
 * selection", and adding a section no longer means re-deriving it.
 *
 * `sel[0]` is the **primary** — the node a mixed field scrubs from and the one
 * whose list rows the fill/stroke/effect sections lay out (Fork P-F1).
 */
export function useSelection(): readonly SceneNode[] {
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const nodes = useEditorStore((s) => s.nodes);
  return useMemo(
    () =>
      selectedIds
        .map((id) => nodes[id])
        .filter((n): n is SceneNode => Boolean(n)),
    [selectedIds, nodes]
  );
}

/** Selection ids that survive the node lookup — the batch-write target set. */
export function selectionIds(sel: readonly SceneNode[]): string[] {
  return sel.map((n) => n.id);
}
