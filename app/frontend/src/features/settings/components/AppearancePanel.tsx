import { useEffect, useState } from "react";
import {
  Info,
  Monitor,
  Moon,
  RotateCcw,
  Sun,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@shared/lib/cn";
import { Brand, TickedSlider } from "@shared/ui";

import {
  APP_ICON_OPTIONS,
  DENSITY_OPTIONS,
  RADIUS_OPTIONS,
  UI_SCALE_MAX_PCT,
  UI_SCALE_MIN_PCT,
  UI_SCALE_STEP_PCT,
  WINDOW_BACKDROP_OPTIONS,
  WINDOW_OPACITY_MAX_PCT,
  WINDOW_OPACITY_MIN_PCT,
  WINDOW_OPACITY_STEP_PCT,
} from "../constants";
import {
  BACKDROP_SAMPLES_LIVE_CONTENT,
  BACKDROP_TUNING_STEP_PCT,
  backdropTuningControls,
  defaultBackdropTuning,
  resolveBackdropTuning,
  withBackdropTuning,
} from "../lib/backdrop";
import type {
  AppearanceSettings,
  BackdropTuning,
  ThemePref,
  WindowBackdrop,
} from "../types";
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
  const [preview, setPreview] = useState({
    uiScale: value.uiScale,
    windowOpacity: value.windowOpacity,
  });

  useEffect(() => {
    setPreview({
      uiScale: value.uiScale,
      windowOpacity: value.windowOpacity,
    });
  }, [value.uiScale, value.windowOpacity]);

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
          Choose the mark shown in the system tray, the taskbar, and inside the
          app. The light / dark variant is picked automatically to match your
          theme.
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
              onPreview={(uiScale) =>
                setPreview((current) => ({ ...current, uiScale }))
              }
              onChange={(uiScale) => onChange({ ...value, uiScale })}
            />
          }
        />
      </SectionCard>

      <SectionCard title="Window">
        <div className="flex items-center gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[var(--color-ink)]">
              Preview
            </p>
            <p className="mt-0.5 text-[12px] text-[var(--color-slate)]">
              Draft window scale and opacity.
            </p>
          </div>
          <WindowPreview
            uiScale={preview.uiScale}
            windowOpacity={preview.windowOpacity}
            backdrop={value.windowBackdrop}
            appIcon={value.appIcon}
          />
        </div>
        <Row
          label="Backdrop"
          description="Choose the native material behind the window. Acrylic is the clearest live blur; Clear removes the material entirely."
          control={
            <Segmented
              options={WINDOW_BACKDROP_OPTIONS}
              selected={value.windowBackdrop}
              onSelect={(windowBackdrop) =>
                onChange({ ...value, windowBackdrop })
              }
            />
          }
        />
        <Row
          label="Transparency"
          description="Controls app chrome opacity. Acrylic and Clear reveal the desktop most reliably."
          control={
            <PercentSlider
              value={value.windowOpacity}
              min={WINDOW_OPACITY_MIN_PCT}
              max={WINDOW_OPACITY_MAX_PCT}
              step={WINDOW_OPACITY_STEP_PCT}
              ariaLabel="Window opacity"
              onPreview={(windowOpacity) =>
                setPreview((current) => ({ ...current, windowOpacity }))
              }
              onChange={(windowOpacity) =>
                onChange({ ...value, windowOpacity })
              }
            />
          }
        />
      </SectionCard>

      <BackdropTuningCard value={value} onChange={onChange} />
    </>
  );
}

/**
 * Per-material tuning for the selected backdrop.
 *
 * Separate from the Window card because the rows *change* with the
 * material: the tint slider is hidden where Windows ignores it, and the
 * heading names the material so it's obvious the numbers belong to that
 * one choice rather than to transparency as a whole.
 *
 * The note at the top is the honest part. Mica and Tabbed are
 * wallpaper-derived, so no slider anywhere can make live content show
 * through them — saying so beats letting the user drag every knob to
 * its end looking for the one that will.
 */
function BackdropTuningCard({ value, onChange }: AppearancePanelProps) {
  const backdrop = value.windowBackdrop;
  const tuning = resolveBackdropTuning(value.backdropTuning, backdrop);
  const shipped = defaultBackdropTuning(backdrop);
  const label =
    WINDOW_BACKDROP_OPTIONS.find((option) => option.value === backdrop)
      ?.label ?? backdrop;
  const isDefault = (Object.keys(shipped) as (keyof BackdropTuning)[]).every(
    (key) => tuning[key] === shipped[key]
  );

  const commit = (next: BackdropTuning) =>
    onChange({
      ...value,
      backdropTuning: withBackdropTuning(value.backdropTuning, backdrop, next),
    });

  return (
    <SectionCard title={`${label} tuning`}>
      <div className="flex items-start gap-3 px-5 py-3">
        <Info
          size={14}
          strokeWidth={1.85}
          className="mt-0.5 shrink-0 text-[var(--color-slate)]"
        />
        <p className="min-w-0 flex-1 text-[12px] text-[var(--color-slate)]">
          {BACKDROP_SAMPLES_LIVE_CONTENT[backdrop]
            ? `${label} samples what is actually behind the window, so these knobs change how much of it reaches you.`
            : `${label} is drawn by Windows from your desktop wallpaper, not from what is behind the window — apps behind Clippity can never show through it at any transparency. Switch to Acrylic or Clear for that. These knobs still control how much of the material itself you see.`}
        </p>
        <button
          type="button"
          disabled={isDefault}
          onClick={() => commit(shipped)}
          className={cn(
            "focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium transition-colors",
            isDefault
              ? "cursor-default text-[var(--color-slate)] opacity-50"
              : "text-[var(--color-ink)] hover:bg-[color:var(--color-overlay-2)]"
          )}
        >
          <RotateCcw size={12} strokeWidth={1.85} />
          Reset
        </button>
      </div>
      {backdropTuningControls(backdrop).map((control) => (
        <Row
          key={control.key}
          label={control.label}
          description={control.description}
          control={
            // `TickedSlider` drives its own draft + readout and commits
            // on release, so these rows need no preview state of their
            // own — unlike the transparency / scale sliders above, whose
            // draft the window preview card also renders.
            <TickedSlider
              value={tuning[control.key]}
              min={control.min}
              max={control.max}
              step={BACKDROP_TUNING_STEP_PCT}
              ariaLabel={control.label}
              onChange={(next) => commit({ ...tuning, [control.key]: next })}
              formatValue={(next) => `${next}%`}
              width={160}
            />
          }
        />
      ))}
    </SectionCard>
  );
}

function WindowPreview({
  uiScale,
  windowOpacity,
  backdrop,
  appIcon,
}: {
  uiScale: number;
  windowOpacity: number;
  backdrop: WindowBackdrop;
  appIcon: AppearanceSettings["appIcon"];
}) {
  const scale = uiScale / 100;
  const backdropLabel =
    WINDOW_BACKDROP_OPTIONS.find((option) => option.value === backdrop)
      ?.label ?? "Mica";

  return (
    <div className="w-[236px] shrink-0">
      <div
        className="grid h-[116px] place-items-center overflow-hidden rounded-[12px] border border-[color:var(--hairline)]"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 24%, transparent), color-mix(in srgb, #4f8cff 18%, transparent) 48%, color-mix(in srgb, var(--color-ink) 12%, transparent))",
        }}
      >
        <div
          className="w-[180px] rounded-[12px] border border-[color:var(--hairline-strong)] p-2 shadow-[var(--shadow-medium)]"
          style={{
            transform: `scale(${scale})`,
            background: `color-mix(in srgb, var(--color-canvas) ${windowOpacity}%, transparent)`,
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <Brand
                variant={appIcon === "monochrome" ? "mono" : "app"}
                size={16}
                showWordmark={false}
              />
              <span className="text-[10px] font-semibold text-[var(--color-ink)]">
                Clippity
              </span>
            </span>
            <span className="h-2 w-8 rounded-full bg-[color:var(--color-overlay-2)]" />
          </div>
          <div className="mt-2 grid grid-cols-[1fr_42px] gap-2">
            <div className="space-y-1.5">
              <span className="block h-2 rounded-full bg-[color:var(--color-overlay-3)]" />
              <span className="block h-2 w-10/12 rounded-full bg-[color:var(--color-overlay-2)]" />
              <span className="block h-2 w-7/12 rounded-full bg-[color:var(--color-overlay-2)]" />
            </div>
            <div className="rounded-[8px] bg-[color:var(--color-accent-soft)]" />
          </div>
        </div>
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10.5px] text-[var(--color-slate)]">
        <span>{uiScale}% scale</span>
        <span>{windowOpacity}% opacity</span>
      </div>
      <p className="sr-only">Backdrop preview: {backdropLabel}</p>
    </div>
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
  onPreview,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  onPreview(next: number): void;
  onChange(next: number): void;
}) {
  return (
    <TickedSlider
      value={value}
      min={min}
      max={max}
      step={step}
      ariaLabel={ariaLabel}
      onPreview={onPreview}
      onChange={onChange}
      formatValue={(next) => `${next}%`}
      width={160}
    />
  );
}
