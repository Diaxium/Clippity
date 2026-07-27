import { cn } from "@shared/lib/cn";

import { STEPS } from "../constants";
import type { StepIndex } from "../types";

interface StepDotsProps {
  step: StepIndex;
}

/**
 * Three-step progress indicator (dot + label, joined by hairlines).
 * Active step's dot uses the accent; completed steps fade the dot
 * tint but keep the label hint colour so the wizard's progress reads
 * at a glance.
 */
export function StepDots({ step }: StepDotsProps) {
  return (
    <div className="flex items-center justify-center gap-2">
      {STEPS.map((entry, i) => {
        const active = i === step;
        const done = i < step;
        return (
          <div key={entry.id} className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "h-2 w-2 rounded-full transition-colors",
                active
                  ? "bg-[var(--color-accent)]"
                  : done
                    ? "bg-[color:color-mix(in_srgb,var(--color-accent)_60%,transparent)]"
                    : "bg-[color:var(--color-overlay-3)]"
              )}
            />
            <span
              className={cn(
                "text-[11.5px] font-medium transition-colors",
                active ? "text-[var(--color-ink)]" : "text-[var(--color-hint)]"
              )}
            >
              {entry.label}
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className="h-px w-6 bg-[color:var(--hairline)]"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
