import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";

import { cn } from "@shared/lib/cn";
import { Brand } from "@shared/ui";

import {
  APP_ICON_OPTIONS,
  DENSITY_OPTIONS,
  RADIUS_OPTIONS,
  UI_SCALE_MAX_PCT,
  UI_SCALE_MIN_PCT,
  UI_SCALE_STEP_PCT,
  WINDOW_OPACITY_MAX_PCT,
  WINDOW_OPACITY_MIN_PCT,
  WINDOW_OPACITY_STEP_PCT,
} from "../constants";
import type { AppearanceSettings, ThemePref } from "../types";
import { AccentPicker } from "./AccentPicker";
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";

interface AppearancePanelProps {
  value: AppearanceSettings;
  onChange(next: AppearanceSettings): void;
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

export function AppearancePanel({ value, onChange }: AppearancePanelProps) {
  return (
    <>
      <SectionCard title="Theme">
        <Row
          label="Color scheme"
          description="System follows your OS preference at runtime."
          control={
            <div className="inline-flex items-center gap-1 rounded-[10px] bg-[color:var(--color-overlay-1)] p-1">
              {THEME_OPTS.map(({ id, label, icon: Icon }) => {
                const active = value.theme === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onChange({ ...value, theme: id })}
                    className={cn(
                      "focus-ring inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                      active
                        ? "bg-[var(--color-surface)] text-[var(--color-ink)] shadow-[var(--shadow-subtle)]"
                        : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
                    )}
                  >
                    <Icon size={13} strokeWidth={1.85} />
                    {label}
                  </button>
                );
              })}
            </div>
          }
        />
      </SectionCard>

      <SectionCard title="Accent">
        <div className="px-5 py-3 text-[12px] text-[var(--color-slate)]">
          Pick from the brand palette or set a custom hex. The active accent
          cascades to highlights, hover states, focus rings, and the capture
          button glow.
        </div>
        <Row
          label="Color"
          control={
            <AccentPicker
              value={value.accent}
              onChange={(accent) => onChange({ ...value, accent })}
            />
          }
        />
      </SectionCard>

      <SectionCard title="App icon">
        <div className="px-5 py-3 text-[12px] text-[var(--color-slate)]">
          Choose the mark shown in the system tray, the taskbar, and inside
          the app. The light / dark variant is picked automatically to match
          your theme.
        </div>
        <Row
          label="Style"
          control={
            <span className="inline-flex items-center gap-3">
              <span className="rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] p-1.5">
                <Brand
                  variant={value.appIcon === "monochrome" ? "mono" : "app"}
                  size={26}
                  showWordmark={false}
                />
              </span>
              <Segmented
                options={APP_ICON_OPTIONS}
                selected={value.appIcon}
                onSelect={(appIcon) => onChange({ ...value, appIcon })}
              />
            </span>
          }
        />
      </SectionCard>

      <SectionCard title="Layout">
        <Row
          label="Corner roundness"
          description="Scales the roundness of cards, panels, and controls."
          control={
            <Segmented
              options={RADIUS_OPTIONS}
              selected={value.cornerRadius}
              onSelect={(cornerRadius) => onChange({ ...value, cornerRadius })}
            />
          }
        />
        <Row
          label="Density"
          description="Compact tightens spacing so more fits on screen."
          control={
            <Segmented
              options={DENSITY_OPTIONS}
              selected={value.density}
              onSelect={(density) => onChange({ ...value, density })}
            />
          }
        />
        <Row
          label="Interface scale"
          description="Zoom the whole interface up or down."
          control={
            <PercentSlider
              value={value.uiScale}
              min={UI_SCALE_MIN_PCT}
              max={UI_SCALE_MAX_PCT}
              step={UI_SCALE_STEP_PCT}
              ariaLabel="Interface scale"
              onChange={(uiScale) => onChange({ ...value, uiScale })}
            />
          }
        />
      </SectionCard>

      <SectionCard title="Window">
        <Row
          label="Transparency"
          description="Let the desktop show through the window chrome. Lower is more see-through."
          control={
            <PercentSlider
              value={value.windowOpacity}
              min={WINDOW_OPACITY_MIN_PCT}
              max={WINDOW_OPACITY_MAX_PCT}
              step={WINDOW_OPACITY_STEP_PCT}
              ariaLabel="Window opacity"
              onChange={(windowOpacity) => onChange({ ...value, windowOpacity })}
            />
          }
        />
      </SectionCard>
    </>
  );
}

/**
 * Generic text-segmented control. Reused for corner roundness, density,
 * and the app-icon style — each an enum with a small, fixed option set.
 * Mirrors the visual language of the Theme picker above (a pill track
 * with a raised active segment) but without the leading icons.
 */
function Segmented<T extends string>({
  options,
  selected,
  onSelect,
}: {
  options: readonly { value: T; label: string; hint?: string }[];
  selected: T;
  onSelect(value: T): void;
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-[10px] bg-[color:var(--color-overlay-1)] p-1">
      {options.map(({ value, label, hint }) => {
        const active = selected === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            title={hint}
            onClick={() => onSelect(value)}
            className={cn(
              "focus-ring rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium transition-colors",
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
  );
}

/**
 * Percent slider with a live monospace readout. Shared by the interface
 * scale and window-transparency rows; the envelope + step come from the
 * caller so each row keeps its own clamp (mirrored on the Rust side).
 */
function PercentSlider({
  value,
  min,
  max,
  step,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onChange(next: number): void;
}) {
  return (
    <span className="inline-flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.currentTarget.value, 10))}
        className="clippity-slider h-1 w-[160px] cursor-pointer appearance-none rounded-full bg-[color:var(--color-overlay-2)]"
        aria-label={ariaLabel}
      />
      <span className="w-11 text-right font-mono text-[12px] text-[var(--color-ink)]">
        {value}%
      </span>
    </span>
  );
}
