import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@shared/lib/cn";

interface CollapsibleSectionProps {
  /** Step number — renders as a small chip before the title. */
  n: number;
  title: string;
  /** Optional right-aligned slot (e.g. a settings shortcut). */
  actions?: ReactNode;
  /** Whether the section starts expanded. Defaults to open. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Numbered "step" section used by the expanded Capture view. The
 * chip-numbered header doubles as a toggle: clicking it collapses or
 * expands the body, with a chevron showing the state. Each section
 * tracks its own open state (defaults to open); the form values it
 * wraps live in the capture store, so collapsing never discards a
 * selection.
 */
export function CollapsibleSection({
  n,
  title,
  actions,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between px-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={contentId}
          className="focus-ring group flex items-center gap-2 rounded-md"
        >
          <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-[color:var(--color-overlay-1)] text-[10px] font-semibold text-[var(--color-slate)]">
            {n}
          </span>
          <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--color-hint)] transition-colors group-hover:text-[var(--color-ink)]">
            {title}
          </span>
          <ChevronDown
            size={14}
            strokeWidth={1.85}
            className={cn(
              "shrink-0 text-[var(--color-hint)] transition-transform duration-200",
              !open && "-rotate-90"
            )}
          />
        </button>
        {actions}
      </header>
      {open && (
        <div id={contentId} className="flex flex-col gap-2">
          {children}
        </div>
      )}
    </section>
  );
}
