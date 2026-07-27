import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { cn } from "@shared/lib/cn";
import type { ThemePref } from "@services/tauri/clients/settings";

import { StepHeader } from "./StepHeader";

interface ThemeStepProps {
  value: ThemePref;
  onChange(next: ThemePref): void;
}

const THEME_OPTS: readonly {
  id: ThemePref;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

/**
 * Step 2 — pick a theme. Clicking a tile applies the choice live
 * through the settings store, so the wizard's surroundings re-tint
 * instantly. The active tile uses the accent border + accent-soft fill
 * so the choice reads at a glance.
 */
export function ThemeStep({ value, onChange }: ThemeStepProps) {
  return (
    <div>
      <StepHeader
        icon={Sun}
        title="Pick a theme"
        description="System follows your OS appearance and updates automatically."
      />
      <div className="grid grid-cols-3 gap-3">
        {THEME_OPTS.map(({ id, label, icon: Icon }) => {
          const active = id === value;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(id)}
              className={cn(
                "focus-ring flex h-[88px] flex-col items-center justify-center gap-2 rounded-[12px] border text-[12.5px] font-medium transition-shadow",
                active
                  ? "border-[color:color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)] shadow-[var(--shadow-medium)]"
                  : "border-[color:var(--hairline)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:shadow-[var(--shadow-medium)]"
              )}
            >
              <Icon size={22} strokeWidth={1.75} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
