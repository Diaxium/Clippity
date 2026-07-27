import type { CaptureMeta, LibraryMode, LibraryView } from "../types";
import { CaptureGrid } from "./CaptureGrid";
import { CaptureList } from "./CaptureList";

interface DaySectionProps {
  /** Section heading — a relative date in the library, a collection's
   *  name when one is open. Absent when the grid is one flat run
   *  (a non-date sort has no honest day grouping to head). */
  heading: string | null;
  items: CaptureMeta[];
  view: LibraryView;
  mode: LibraryMode;
  onFocus: (m: CaptureMeta) => void;
  onOpen: (m: CaptureMeta) => void;
  onDelete: (m: CaptureMeta) => void;
  onRestore: (m: CaptureMeta) => void;
  onPurge: (m: CaptureMeta) => void;
}

/** One group of captures: a heading + the grid-or-list body. */
export function DaySection({
  heading,
  items,
  view,
  mode,
  onFocus,
  onOpen,
  onDelete,
  onRestore,
  onPurge,
}: DaySectionProps) {
  const body =
    view === "grid" ? (
      <CaptureGrid
        items={items}
        mode={mode}
        onFocus={onFocus}
        onOpen={onOpen}
        onDelete={onDelete}
        onRestore={onRestore}
        onPurge={onPurge}
      />
    ) : (
      <CaptureList
        items={items}
        mode={mode}
        onFocus={onFocus}
        onOpen={onOpen}
        onDelete={onDelete}
        onRestore={onRestore}
        onPurge={onPurge}
      />
    );

  return (
    <section className="mt-5 first:mt-0">
      {heading && (
        <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-hint)]">
          {heading}
        </h3>
      )}
      {body}
    </section>
  );
}
