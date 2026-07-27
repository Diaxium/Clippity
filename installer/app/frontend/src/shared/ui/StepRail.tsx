import { Check } from "lucide-react";
import { motion } from "motion/react";

import type { StepId } from "@clippity/installer-shared";
import { cn } from "@shared/lib/cn";
import type { IconComponent } from "@shared/lib/icon";
import type { RailStep } from "@state/wizardStore";

interface StepRailProps {
  steps: RailStep[];
  current: StepId;
  /** Optional per-step icon; falls back to the step number when absent. */
  icons?: Partial<Record<StepId, IconComponent>>;
}

/**
 * The left navigation rail. Every step before the active one reads as
 * completed (a check), the active step is accented, and later steps are
 * dimmed — the pattern the design boards use across all three flows.
 */
export function StepRail({ steps, current, icons }: StepRailProps) {
  const activeIndex = steps.findIndex((s) => s.id === current);

  return (
    <nav
      aria-label="Setup steps"
      className="sidebar-grad flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-[var(--hairline)] p-3"
    >
      {steps.map((step, i) => {
        const done = i < activeIndex;
        const active = i === activeIndex;
        const Icon = icons?.[step.id];
        return (
          <div
            key={step.id}
            aria-current={active ? "step" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-2 text-[12.5px] transition-colors",
              active && "bg-[var(--color-accent-soft)]"
            )}
          >
            <span
              className={cn(
                "grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full text-[11px] font-semibold transition-colors",
                done && "bg-[var(--color-accent)] text-[var(--color-accent-ink)]",
                active &&
                  "bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[0_0_0_3px_var(--color-accent-soft)]",
                !done &&
                  !active &&
                  "bg-[var(--color-overlay-2)] text-[var(--color-hint)]"
              )}
            >
              {done ? (
                <Check size={13} strokeWidth={2.6} />
              ) : Icon ? (
                <Icon size={13} strokeWidth={1.9} />
              ) : (
                i + 1
              )}
            </span>
            <span
              className={cn(
                "truncate font-medium",
                active
                  ? "text-[var(--color-accent)]"
                  : done
                    ? "text-[var(--color-ink)]"
                    : "text-[var(--color-hint)]"
              )}
            >
              {step.label}
            </span>
            {active && (
              <motion.span
                layoutId="rail-active-dot"
                className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]"
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
