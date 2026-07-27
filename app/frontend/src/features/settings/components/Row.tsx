import type { ReactNode } from "react";

interface RowProps {
  label: string;
  description?: string;
  control: ReactNode;
}

/**
 * Label + optional description on the left, control on the right.
 * The settings panels are composed of these rows + `SectionCard`s.
 */
export function Row({ label, description, control }: RowProps) {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-[var(--color-ink)]">
          {label}
        </p>
        {description && (
          <p className="mt-0.5 text-[12px] text-[var(--color-slate)]">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
