import type { LucideIcon } from "lucide-react";

interface StepHeaderProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

/**
 * Per-step heading cluster: accent-soft icon tile + title + supporting
 * paragraph. Shared by all three steps so spacing + type stays in
 * lock-step.
 */
export function StepHeader({
  icon: Icon,
  title,
  description,
}: StepHeaderProps) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
        <Icon size={18} strokeWidth={1.85} />
      </span>
      <div className="min-w-0">
        <h2 className="text-[16px] font-semibold text-[var(--color-ink)]">
          {title}
        </h2>
        <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--color-slate)]">
          {description}
        </p>
      </div>
    </div>
  );
}
