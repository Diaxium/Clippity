import { FolderOpen } from "lucide-react";

import { cn } from "@shared/lib/cn";

interface CapturesDirFieldProps {
  value: string;
  /** Placeholder shown when the user hasn't set an override. */
  fallbackHint: string;
  onChange(next: string): void;
  onBrowse(): void;
}

/**
 * Text field + Browse button. Empty value means "use the backend
 * fallback dir" — the placeholder communicates that explicitly.
 */
export function CapturesDirField({
  value,
  fallbackHint,
  onChange,
  onBrowse,
}: CapturesDirFieldProps) {
  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="text"
        value={value}
        placeholder={fallbackHint}
        onChange={(e) => onChange(e.currentTarget.value)}
        className={cn(
          "focus-ring h-9 w-[280px] rounded-[8px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-3 text-[12.5px] font-mono",
          "text-[var(--color-ink)] placeholder:text-[var(--color-hint)]"
        )}
        aria-label="Captures directory"
      />
      <button
        type="button"
        onClick={onBrowse}
        className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-3 text-[12.5px] font-medium text-[var(--color-ink)] shadow-[var(--shadow-subtle)] transition-shadow hover:shadow-[var(--shadow-medium)]"
      >
        <FolderOpen size={14} strokeWidth={1.85} />
        Browse
      </button>
    </span>
  );
}
