import type { ReactNode } from "react";

import { LayoutGrid, List } from "lucide-react";

import { cn } from "@shared/lib/cn";

import type { LibraryView } from "../types";

/** Grid / list switcher pinned to the right of the kind tabs. */
export function ViewToggle({
  view,
  onViewChange,
}: {
  view: LibraryView;
  onViewChange: (v: LibraryView) => void;
}) {
  return (
    <div className="flex items-center rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-0.5 shadow-[var(--shadow-subtle)]">
      <Btn
        active={view === "grid"}
        onClick={() => onViewChange("grid")}
        label="Grid view"
      >
        <LayoutGrid size={15} strokeWidth={1.85} />
      </Btn>
      <Btn
        active={view === "list"}
        onClick={() => onViewChange("list")}
        label="List view"
      >
        <List size={15} strokeWidth={1.85} />
      </Btn>
    </div>
  );
}

function Btn({
  children,
  active,
  onClick,
  label,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cn(
        "focus-ring grid h-8 w-9 place-items-center rounded-[8px] transition-colors",
        active
          ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
          : "text-[var(--color-slate)] hover:text-[var(--color-ink)]"
      )}
    >
      {children}
    </button>
  );
}
