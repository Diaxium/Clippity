import { useMemo } from "react";

import { cn } from "@shared/lib/cn";

import { ACCENT_PRESETS } from "../constants";

interface AccentPickerProps {
  value: string;
  onChange(next: string): void;
}

/**
 * Preset palette swatches + a custom hex input. The custom input
 * uppercases on every change so the displayed string is canonical
 * — matches the legacy normalization.
 */
export function AccentPicker({ value, onChange }: AccentPickerProps) {
  const normalised = useMemo(() => normaliseHex(value), [value]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {ACCENT_PRESETS.map((preset) => {
          const active = preset.value.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={preset.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(preset.value)}
              title={preset.label}
              className={cn(
                "focus-ring inline-flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-[12px] font-medium transition-shadow",
                active
                  ? "border-[color:var(--color-accent)] text-[var(--color-ink)] shadow-[var(--shadow-medium)]"
                  : "border-[color:var(--hairline)] text-[var(--color-slate)] hover:shadow-[var(--shadow-medium)]"
              )}
            >
              <span
                className="h-4 w-4 rounded-full border border-[color:var(--hairline)]"
                style={{ background: preset.value }}
              />
              {preset.label}
            </button>
          );
        })}
      </div>
      <span className="inline-flex items-center gap-2 self-start rounded-[8px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-2.5 py-1.5">
        <input
          type="color"
          value={normalised}
          onChange={(e) => onChange(e.currentTarget.value.toUpperCase())}
          className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch-wrapper]:rounded [&::-webkit-color-swatch-wrapper]:p-0"
          aria-label="Custom accent color"
        />
        <span className="font-mono text-[12px] text-[var(--color-slate)]">
          {normalised}
        </span>
      </span>
    </div>
  );
}

function normaliseHex(value: string): string {
  const m = value.match(/^#([0-9a-fA-F]{6})$/);
  return m ? `#${m[1]!.toUpperCase()}` : value;
}
