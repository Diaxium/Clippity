import type { CaptureMeta, LibraryMode } from "../types";
import { CaptureRow } from "./CaptureRow";

interface CaptureListProps {
  items: CaptureMeta[];
  mode: LibraryMode;
  onFocus: (m: CaptureMeta) => void;
  onOpen: (m: CaptureMeta) => void;
  onDelete: (m: CaptureMeta) => void;
  onRestore: (m: CaptureMeta) => void;
  onPurge: (m: CaptureMeta) => void;
}

/** Vertical list of capture rows for one group. */
export function CaptureList({
  items,
  mode,
  onFocus,
  onOpen,
  onDelete,
  onRestore,
  onPurge,
}: CaptureListProps) {
  return (
    <ul className="flex flex-col divide-y divide-[color:var(--hairline)] overflow-hidden rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface)]">
      {items.map((m) => (
        <CaptureRow
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
    </ul>
  );
}
