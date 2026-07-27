import { cn } from "@shared/lib/cn";

import { CATEGORIES } from "../constants";
import type { SettingsCategory } from "../types";

interface CategoryNavProps {
  active: SettingsCategory;
  onPick(next: SettingsCategory): void;
}

/**
 * Left-rail navigation for the settings dashboard. Coming-soon
 * categories render at reduced opacity but are still clickable —
 * picking one lands on the `ComingSoonPanel` placeholder so the user
 * sees what's blocked rather than getting silently denied.
 */
export function CategoryNav({ active, onPick }: CategoryNavProps) {
  return (
    <nav className="w-[220px] shrink-0 overflow-y-auto border-r border-[color:var(--hairline)] p-3.5">
      <ul className="flex flex-col gap-0.5">
        {CATEGORIES.map(({ id, label, icon: Icon, built }) => {
          const isActive = id === active;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onPick(id)}
                aria-pressed={isActive}
                aria-disabled={!built}
                className={cn(
                  "focus-ring relative flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-[13px] font-medium transition-colors",
                  isActive
                    ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]",
                  !built && !isActive && "opacity-60"
                )}
              >
                <Icon size={16} strokeWidth={1.85} />
                <span className="flex-1">{label}</span>
                {!built && (
                  <span className="rounded-[6px] bg-[color:var(--color-overlay-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-hint)]">
                    Soon
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
