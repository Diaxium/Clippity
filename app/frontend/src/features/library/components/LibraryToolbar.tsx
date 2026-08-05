import type { ReactNode } from "react";

import { PanelRight, Search, X } from "lucide-react";

import { Select } from "@shared/ui";
import { cn } from "@shared/lib/cn";

import type { LibrarySort, LibraryView } from "../types";
import { ViewToggle } from "./ViewToggle";

const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Name" },
  { value: "largest", label: "Largest" },
] as const;

interface LibraryToolbarProps {
  /** Name of the open destination — what the sidebar row said. */
  scopeLabel: string;
  count: number;
  loading: boolean;
  sort: LibrarySort;
  onSort: (s: LibrarySort) => void;
  view: LibraryView;
  onView: (v: LibraryView) => void;
  /** Refinements layered on top of the scope, each with its own way out. */
  search: string;
  onClearSearch: () => void;
  tagFilter: string | null;
  onClearTag: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

/**
 * The strip above the grid: what you are looking at on the left, how it
 * is arranged on the right.
 *
 * It answers the question the rail can't — *how many, and in what
 * order* — and it is where the refinements that aren't destinations
 * (the search box, a tag) show up as removable chips. Putting them here
 * rather than leaving them implicit in the rail matters: a grid narrowed
 * by a tag chosen three clicks ago and a grid that is genuinely empty
 * look identical otherwise.
 */
export function LibraryToolbar({
  scopeLabel,
  count,
  loading,
  sort,
  onSort,
  view,
  onView,
  search,
  onClearSearch,
  tagFilter,
  onClearTag,
  inspectorOpen,
  onToggleInspector,
}: LibraryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-3 pt-1">
      <h2 className="text-[13.5px] font-semibold text-[var(--color-ink)]">
        {scopeLabel}
      </h2>
      <span className="text-[12.5px] text-[var(--color-hint)]">
        {loading && count === 0
          ? "Loading…"
          : `${count.toLocaleString()} item${count === 1 ? "" : "s"}`}
      </span>

      {tagFilter && (
        <Chip
          label={tagFilter}
          onClear={onClearTag}
          clearLabel="Clear tag filter"
        />
      )}
      {search.trim() && (
        <Chip
          icon={<Search size={11} strokeWidth={2.2} />}
          label={`“${search.trim()}”`}
          onClear={onClearSearch}
          clearLabel="Clear search"
        />
      )}

      <div className="ml-auto flex items-center gap-2">
        <span className="hidden text-[12.5px] text-[var(--color-slate)] sm:inline">
          Sort:
        </span>
        <div className="w-[118px]">
          <Select
            value={sort}
            options={SORT_OPTIONS}
            onChange={(v) => onSort(v as LibrarySort)}
            ariaLabel="Sort captures"
            triggerClassName="h-8 rounded-[9px] px-2 text-[12.5px] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
          />
        </div>
        <ViewToggle view={view} onViewChange={onView} />
        <button
          type="button"
          onClick={onToggleInspector}
          aria-pressed={inspectorOpen}
          aria-label={inspectorOpen ? "Hide details" : "Show details"}
          title={inspectorOpen ? "Hide details" : "Show details"}
          className={cn(
            "focus-ring grid h-8 w-8 place-items-center rounded-[9px] transition-colors",
            inspectorOpen
              ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
              : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
          )}
        >
          <PanelRight size={15} strokeWidth={1.85} />
        </button>
      </div>
    </div>
  );
}

/** An active refinement, with the button that takes it off. */
function Chip({
  icon,
  label,
  onClear,
  clearLabel,
}: {
  icon?: ReactNode;
  label: string;
  onClear: () => void;
  clearLabel: string;
}) {
  return (
    <span className="inline-flex max-w-[14rem] items-center gap-1.5 rounded-full bg-[color:var(--color-accent-soft)] py-1 pl-2.5 pr-1 text-[11.5px] font-medium text-[var(--color-accent)]">
      {icon}
      <span className="truncate">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={clearLabel}
        title={clearLabel}
        className="focus-ring grid h-4 w-4 shrink-0 place-items-center rounded-full hover:bg-[color:var(--color-overlay-2)]"
      >
        <X size={10} strokeWidth={2.6} />
      </button>
    </span>
  );
}
