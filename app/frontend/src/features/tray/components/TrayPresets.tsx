import { ChevronRight } from "lucide-react";

import { openDashboard } from "@services/tauri/clients/dashboard";
import type { CapturePreset } from "@services/tauri/clients/presets";
import { usePresets } from "@shared/hooks/usePresets";
import { captureTypeMeta } from "@shared/lib/captureTypeMeta";

interface TrayPresetsProps {
  /** Run a preset (the panel hides first, then dispatches). */
  onRun: (preset: CapturePreset) => void;
}

/** How many presets the compact flyout lists; the rest live behind
 *  "Manage". */
const TRAY_PRESET_LIMIT = 4;

/**
 * The tray's Presets section — quick-launch rows for saved presets, with
 * a "Manage" link into the dashboard manager. Empty state nudges the
 * user to create one. Mirrors `clippity://presets/changed` via the
 * shared `usePresets` hook.
 */
export function TrayPresets({ onRun }: TrayPresetsProps) {
  const { presets } = usePresets();

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] font-semibold tracking-[0.06em] text-[var(--color-hint)] uppercase">
          Presets
        </span>
        <button
          type="button"
          onClick={() => void openDashboard("presets")}
          className="focus-ring no-drag rounded px-1 text-[11px] font-medium text-[var(--color-slate)] transition-colors hover:text-[var(--color-ink)]"
        >
          Manage
        </button>
      </div>

      {presets.length === 0 ? (
        <button
          type="button"
          onClick={() => void openDashboard("presets")}
          className="focus-ring no-drag grid h-[40px] place-items-center rounded-[12px] border border-dashed border-[color:var(--hairline-strong)] text-[12px] text-[var(--color-hint)] transition-colors hover:text-[var(--color-ink)]"
        >
          Create a preset →
        </button>
      ) : (
        <div className="flex flex-col gap-1">
          {presets.slice(0, TRAY_PRESET_LIMIT).map((p) => {
            const Icon = captureTypeMeta(p.request.type).icon;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onRun(p)}
                title={`Run ${p.name}`}
                className="focus-ring no-drag flex items-center gap-2.5 rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-2.5 py-2 text-left transition-shadow hover:shadow-[var(--shadow-medium)]"
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-[var(--color-tile-cool)] text-[var(--color-tile-cool-ink)]">
                  <Icon size={14} strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-ink)]">
                  {p.name}
                </span>
                <ChevronRight
                  size={14}
                  className="shrink-0 text-[var(--color-hint)]"
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
