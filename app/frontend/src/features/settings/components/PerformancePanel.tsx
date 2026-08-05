import { RotateCcw } from "lucide-react";

import { relaunchApp } from "@services/tauri/clients/settings";
import { cn } from "@shared/lib/cn";
import { ToggleSwitch } from "@shared/ui";

import { CAPTURE_COMPRESSION_OPTIONS } from "../constants";
import type { PerformanceSettings } from "../types";
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";

interface PerformancePanelProps {
  value: PerformanceSettings;
  onChange(next: PerformanceSettings): void;
}

/**
 * The GPU-acceleration value the running WebView2 actually booted with.
 * Captured once per window (each Tauri window has its own JS realm) on
 * the first render that has live settings, so the "restart to apply"
 * prompt survives the user navigating away from + back to this tab —
 * the browser arg is fixed at webview-environment creation, so only a
 * fresh process picks up a change.
 */
let bootGpuAcceleration: boolean | null = null;

export function PerformancePanel({ value, onChange }: PerformancePanelProps) {
  // First render with settings present establishes the boot baseline.
  if (bootGpuAcceleration === null) bootGpuAcceleration = value.gpuAcceleration;
  const gpuChanged = value.gpuAcceleration !== bootGpuAcceleration;

  const activeCompression = CAPTURE_COMPRESSION_OPTIONS.find(
    (o) => o.value === value.captureCompression
  );

  return (
    <>
      <SectionCard title="Rendering">
        <Row
          label="Hardware acceleration"
          description="Render the app on the GPU. Turning this off can fix flickering or graphics-driver glitches, at the cost of some smoothness. Applies after a restart."
          control={
            <ToggleSwitch
              checked={value.gpuAcceleration}
              onChange={(gpuAcceleration) =>
                onChange({ ...value, gpuAcceleration })
              }
              label="Hardware acceleration"
            />
          }
        />
        {gpuChanged && (
          <div className="flex items-center gap-3 bg-[color:var(--color-accent-soft)] px-5 py-3">
            <RotateCcw
              size={15}
              strokeWidth={1.9}
              className="shrink-0 text-[var(--color-accent)]"
            />
            <p className="flex-1 text-[12px] text-[var(--color-ink)]">
              Restart Clippity to apply the hardware-acceleration change.
            </p>
            <button
              type="button"
              onClick={() => void relaunchApp()}
              className="focus-ring shrink-0 rounded-[8px] bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-semibold text-[var(--color-accent-ink)] transition-opacity hover:opacity-90"
            >
              Restart now
            </button>
          </div>
        )}
        <Row
          label="Transparency & blur effects"
          description="Native window materials and frosted-glass surfaces. Turn off for a flat, opaque look that's lighter on the GPU and compositor."
          control={
            <ToggleSwitch
              checked={value.windowEffects}
              onChange={(windowEffects) =>
                onChange({ ...value, windowEffects })
              }
              label="Transparency and blur effects"
            />
          }
        />
        <Row
          label="Reduced animations"
          description="Minimize non-essential motion and transitions for a snappier, lower-overhead feel."
          control={
            <ToggleSwitch
              checked={value.reducedAnimations}
              onChange={(reducedAnimations) =>
                onChange({ ...value, reducedAnimations })
              }
              label="Reduced animations"
            />
          }
        />
      </SectionCard>

      <SectionCard title="Capture">
        <Row
          label="Image compression"
          description={
            activeCompression
              ? `Trade capture-save speed against file size. ${activeCompression.hint}.`
              : "Trade capture-save speed against file size."
          }
          control={
            <div className="inline-flex items-center gap-1 rounded-[10px] bg-[color:var(--color-overlay-1)] p-1">
              {CAPTURE_COMPRESSION_OPTIONS.map(({ value: option, label }) => {
                const active = value.captureCompression === option;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChange({ ...value, captureCompression: option })
                    }
                    className={cn(
                      "focus-ring inline-flex items-center rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                      active
                        ? "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-subtle)]"
                        : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          }
        />
      </SectionCard>
    </>
  );
}
