import { Star } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { setFavorite } from "../lib/labelActions";
import type { CaptureMeta } from "../types";

/**
 * One-click star toggle for a card or row.
 *
 * Optimistic in appearance only — it fires the IPC and lets the
 * backend's `library/updated` bring the new state back, the same loop
 * delete/restore use. A star is cheap to re-render and the round trip is
 * a single sidecar write, so holding local state here would buy a few
 * milliseconds in exchange for a second source of truth.
 *
 * A starred capture keeps its filled star at rest; an unstarred one
 * shows the outline only on hover or focus, so the grid isn't a field of
 * grey stars.
 */
export function FavoriteButton({
  meta,
  className,
  alwaysVisible = false,
}: {
  meta: CaptureMeta;
  className?: string;
  /** Keep the outline star showing at rest. For hosts with no hover
   *  group to reveal it — the inspector shows one capture, so there is
   *  no field of grey stars to avoid. */
  alwaysVisible?: boolean;
}) {
  const favorite = meta.favorite === true;
  const label = favorite ? "Remove from favorites" : "Add to favorites";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={favorite}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        void setFavorite([meta.id], !favorite);
      }}
      className={cn(
        "focus-ring grid h-7 w-7 place-items-center rounded-md transition-colors",
        favorite
          ? "text-[var(--color-accent)]"
          : cn(
              "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]",
              !alwaysVisible &&
                "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
            ),
        className
      )}
    >
      <Star
        size={14}
        strokeWidth={1.85}
        fill={favorite ? "currentColor" : "none"}
      />
    </button>
  );
}
