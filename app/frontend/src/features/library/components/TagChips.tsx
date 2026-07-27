import { cn } from "@shared/lib/cn";

import { useLibraryStore } from "../state/libraryStore";
import type { CaptureMeta } from "../types";

/**
 * A capture's tags, rendered as clickable chips on its card or row.
 *
 * Clicking a chip filters the library to that tag — the shortest path
 * from "I see this label" to "show me the rest of these", and the reason
 * the chips are buttons rather than text. The chip for the tag already
 * being filtered on reads as active, so it is obvious which one you are
 * looking through.
 *
 * Renders nothing when a capture has no tags: an empty chip row would
 * cost every untagged card a line of vertical space for nothing.
 */
export function TagChips({
  meta,
  max = 3,
  className,
}: {
  meta: CaptureMeta;
  /** Beyond this, the rest collapse into a `+N` chip — a card is not a
   *  tag manager, and a capture with a dozen tags must not push its own
   *  title off the card. */
  max?: number;
  className?: string;
}) {
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const setTagFilter = useLibraryStore((s) => s.setTagFilter);
  const tags = meta.tags ?? [];
  if (tags.length === 0) return null;

  const shown = tags.slice(0, max);
  const hidden = tags.length - shown.length;
  const active = (tag: string) =>
    tagFilter !== null && tagFilter.toLowerCase() === tag.toLowerCase();

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((tag) => (
        <button
          key={tag}
          type="button"
          title={active(tag) ? `Clear the ${tag} filter` : `Show only ${tag}`}
          onClick={(e) => {
            e.stopPropagation();
            setTagFilter(active(tag) ? null : tag);
          }}
          className={cn(
            "focus-ring max-w-[10rem] truncate rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors",
            active(tag)
              ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
              : "bg-[color:var(--color-overlay-1)] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
          )}
        >
          {tag}
        </button>
      ))}
      {hidden > 0 && (
        <span
          title={tags.join(", ")}
          className="rounded-full px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--color-hint)]"
        >
          +{hidden}
        </span>
      )}
    </div>
  );
}
