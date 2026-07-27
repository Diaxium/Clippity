import { Check } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { useLibraryStore } from "../state/libraryStore";

/**
 * Per-capture multi-select box.
 *
 * There is no separate "selection mode" to enter: ticking one box starts
 * a selection, clearing the last one ends it. A mode toggle would put a
 * step between the user and the thing they already decided to do, and
 * leave a third state ("in selection mode, nothing selected") that means
 * nothing.
 *
 * Hidden until hover or focus while unchecked — a permanent checkbox on
 * every card would read as a form, not a gallery — and always visible
 * once checked, since a selection you can't see is a selection you'll
 * act on by accident.
 */
export function SelectCheckbox({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  const selected = useLibraryStore((s) => s.selected.includes(id));
  const toggleSelected = useLibraryStore((s) => s.toggleSelected);

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={selected ? "Deselect capture" : "Select capture"}
      title={selected ? "Deselect" : "Select"}
      onClick={(e) => {
        e.stopPropagation();
        toggleSelected(id);
      }}
      className={cn(
        "focus-ring grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border transition-all",
        selected
          ? "border-transparent bg-[var(--color-accent)] text-white opacity-100"
          : "border-[color:var(--hairline-strong)] bg-[var(--color-surface)]/85 text-transparent opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
        className
      )}
    >
      <Check size={12} strokeWidth={3} />
    </button>
  );
}
