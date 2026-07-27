import { FolderOpen } from "lucide-react";

import { StepHeader } from "./StepHeader";

interface StorageStepProps {
  value: string;
  /** Resolved default path the backend would use when `value` is blank. */
  defaultHint: string;
  onBrowse(): void;
  onReset(): void;
}

/**
 * Step 1 — choose where captures land. The user either keeps the
 * default (`value === ""` → render `defaultHint`) or browses for a
 * custom directory. A "Use default" pill appears when they've picked
 * a custom path so they can revert without retyping.
 */
export function StorageStep({
  value,
  defaultHint,
  onBrowse,
  onReset,
}: StorageStepProps) {
  const isCustom = value !== "";
  return (
    <div>
      <StepHeader
        icon={FolderOpen}
        title="Where should captures live?"
        description="You can change this any time from Settings → General."
      />
      <div className="rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-3.5 shadow-[var(--shadow-subtle)]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-hint)]">
          Current location
        </p>
        <p className="mt-1.5 break-all font-mono text-[12px] text-[var(--color-ink)]">
          {value || defaultHint || "…"}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onBrowse}
            className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[color:var(--hairline-strong)] bg-[var(--color-surface)] px-3 text-[12px] font-semibold text-[var(--color-ink)] shadow-[var(--shadow-subtle)] hover:shadow-[var(--shadow-medium)]"
          >
            <FolderOpen size={13} strokeWidth={1.85} />
            Browse…
          </button>
          {isCustom && (
            <button
              type="button"
              onClick={onReset}
              className="focus-ring inline-flex h-8 items-center rounded-[8px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-3 text-[12px] font-medium text-[var(--color-slate)] hover:text-[var(--color-ink)]"
            >
              Use default
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
