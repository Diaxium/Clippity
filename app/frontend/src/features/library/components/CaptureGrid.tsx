import type { CaptureMeta, LibraryMode } from "../types";
import { CaptureCard } from "./CaptureCard";

interface CaptureGridProps {
  items: CaptureMeta[];
  mode: LibraryMode;
  onFocus: (m: CaptureMeta) => void;
  onOpen: (m: CaptureMeta) => void;
  onDelete: (m: CaptureMeta) => void;
  onRestore: (m: CaptureMeta) => void;
  onPurge: (m: CaptureMeta) => void;
}

/**
 * Grid of capture cards for one group.
 *
 * Columns come from `auto-fill` against a minimum card width rather than
 * from breakpoints: the grid's width now depends on two things that
 * change independently of the window (the destination rail, and whether
 * the inspector is open), so a `md:`/`xl:` ladder keyed to the viewport
 * would pick the wrong count exactly when the panes move.
 */
export function CaptureGrid({
  items,
  mode,
  onFocus,
  onOpen,
  onDelete,
  onRestore,
  onPurge,
}: CaptureGridProps) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
      {items.map((m) => (
        <CaptureCard
          key={m.id}
          meta={m}
          mode={mode}
          onFocus={onFocus}
          onOpen={onOpen}
          onDelete={onDelete}
          onRestore={onRestore}
          onPurge={onPurge}
        />
      ))}
    </div>
  );
}
