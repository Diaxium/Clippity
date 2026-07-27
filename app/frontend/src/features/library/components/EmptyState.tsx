import { Focus, ImageOff } from "lucide-react";

import { showCaptureWindow } from "@services/tauri/clients/toast";

import { KIND_TABS } from "../modes";
import type { KindTab, LibraryMode } from "../types";

/** What the page is currently narrowed by, for the empty message. */
export interface EmptyStateContext {
  mode: LibraryMode;
  kindFilter: KindTab;
  favoritesOnly: boolean;
  tagFilter: string | null;
  /** Name of the collection being viewed, if any. */
  collectionName: string | null;
  /** Current search query, if the box has anything in it. */
  search?: string;
  /** Label of the active smart collection, if one is open. */
  smartLabel?: string | null;
}

/**
 * The message for an empty list. Pure — exported for tests.
 *
 * Named narrowest-first: with several refinements active, the one the
 * user most recently reached for is the one they can undo, so the
 * message points at that rather than at "no captures", which would be
 * false with a full library behind the filter.
 */
export function emptyStateMessage(ctx: EmptyStateContext): string {
  if (ctx.mode === "trash" && !ctx.search?.trim())
    return "Deleted captures show up here.";
  // Search leads (except over an empty trash, above): typing is the most
  // recent thing the user did, so it is the refinement they are holding
  // in mind and the one they can undo without hunting for it.
  if (ctx.search?.trim()) return `Nothing matches “${ctx.search.trim()}”.`;
  if (ctx.tagFilter) return `Nothing tagged “${ctx.tagFilter}”.`;
  if (ctx.favoritesOnly)
    return "No favorites yet — star a capture to pin it here.";
  if (ctx.smartLabel) return `Nothing in “${ctx.smartLabel}” right now.`;
  if (ctx.collectionName)
    return `“${ctx.collectionName}” is empty — select captures and add them to it.`;
  if (ctx.kindFilter !== "all") {
    const label =
      KIND_TABS.find((t) => t.id === ctx.kindFilter)?.label.toLowerCase() ??
      "captures";
    return `No ${label} yet — they'll appear here once you capture some.`;
  }
  return "Your captures will appear here.";
}

/**
 * Mode- and filter-aware empty state. Renders nothing while the first
 * load is in flight (avoids a flash of "no captures" before the list
 * arrives). When nothing is narrowing the view it offers the next step —
 * jumping to the capture window — so an empty library is a starting
 * point, not a dead end; behind a filter that button would be a
 * non-sequitur, since the captures exist and are simply hidden.
 */
export function EmptyState({
  context,
  loading,
}: {
  context: EmptyStateContext;
  loading: boolean;
}) {
  if (loading) return null;
  const filtered =
    context.tagFilter !== null ||
    context.favoritesOnly ||
    context.collectionName !== null ||
    !!context.smartLabel ||
    !!context.search?.trim() ||
    context.kindFilter !== "all";
  return (
    <div className="grid h-full flex-1 place-items-center py-20 text-center">
      <div className="flex flex-col items-center gap-2.5">
        <ImageOff
          size={26}
          strokeWidth={1.6}
          className="text-[var(--color-hint)]"
        />
        <p className="text-[13px] text-[var(--color-slate)]">
          {emptyStateMessage(context)}
        </p>
        {context.mode === "library" && !filtered && (
          <button
            type="button"
            onClick={() => void showCaptureWindow()}
            className="focus-ring mt-1 inline-flex items-center gap-2 rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink)] shadow-[var(--shadow-subtle)] transition-colors hover:border-[color:var(--color-accent)]/45 hover:text-[var(--color-accent)]"
          >
            <Focus size={15} strokeWidth={1.85} />
            Take a capture
          </button>
        )}
      </div>
    </div>
  );
}
