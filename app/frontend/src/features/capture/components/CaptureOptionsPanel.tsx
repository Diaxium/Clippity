import {
  Clipboard,
  Clock,
  Eye,
  MousePointer2,
  MoveVertical,
  Palette,
  Settings,
  Sparkles,
} from "lucide-react";

import { useSettingsPatch, useSettingsStore } from "@features/settings";
import { ScrollDirectionPicker, ToggleSwitch } from "@shared/ui";
import { cn } from "@shared/lib/cn";

import { useCaptureStore } from "../state/captureStore";
import { OPTION_UNAVAILABLE_HINT, visibleOptionKeys } from "../modes";
import type { ModeIcon, ModeTint } from "../types";
import { CollapsibleSection } from "./CollapsibleSection";
import { DelayStepper } from "./DelayStepper";
import { IconTile } from "./IconTile";
import { SwatchCountStepper } from "./SwatchCountStepper";

/** Fallback swatch count shown until settings hydrate (mirrors the
 *  backend's `DEFAULT_PALETTE_COUNT`). */
const DEFAULT_PALETTE_COUNT = 6;

interface OptionDef {
  key: "preview" | "clipboard" | "cursor" | "enhance" | "delay";
  label: string;
  desc: string;
  icon: ModeIcon;
  tint: ModeTint;
}

const OPTIONS: readonly OptionDef[] = [
  {
    key: "preview",
    label: "Preview in Editor",
    desc: "Open capture in editor after taking",
    icon: Eye,
    tint: "warm",
  },
  {
    key: "clipboard",
    label: "Copy to Clipboard",
    desc: "Copy capture to clipboard",
    icon: Clipboard,
    tint: "cool",
  },
  {
    key: "cursor",
    label: "Capture Cursor",
    desc: "Include cursor in your capture",
    icon: MousePointer2,
    tint: "warm",
  },
  {
    key: "enhance",
    label: "Smart Enhance",
    desc: "Auto-level and sharpen the capture",
    icon: Sparkles,
    tint: "cool",
  },
  {
    key: "delay",
    label: "5 Second Delay",
    desc: "Add a delay before capturing",
    icon: Clock,
    tint: "cool",
  },
];

interface CaptureOptionsPanelProps {
  startIndex?: number;
  /** Settings-button click handler — opens the main hub on /settings. */
  onOpenSettings: () => void;
}

/**
 * Four-row capture options panel. Per-mode visibility comes from
 * `visibleOptionKeys`; rows that are disabled in MVP wear an
 * "Available with <port>" tooltip via `OPTION_UNAVAILABLE_HINT`.
 */
export function CaptureOptionsPanel({
  startIndex = 2,
  onOpenSettings,
}: CaptureOptionsPanelProps) {
  const captureType = useCaptureStore((s) => s.captureType);
  const customMode = useCaptureStore((s) => s.customMode);
  const preview = useCaptureStore((s) => s.preview);
  const clipboard = useCaptureStore((s) => s.clipboard);
  const cursor = useCaptureStore((s) => s.cursor);
  const enhance = useCaptureStore((s) => s.enhance);
  const delayEnabled = useCaptureStore((s) => s.delayEnabled);
  const delaySeconds = useCaptureStore((s) => s.delaySeconds);
  const scrollDirection = useCaptureStore((s) => s.scrollDirection);
  const setOption = useCaptureStore((s) => s.setOption);
  const setDelayEnabled = useCaptureStore((s) => s.setDelayEnabled);
  const setDelaySeconds = useCaptureStore((s) => s.setDelaySeconds);
  const setScrollDirection = useCaptureStore((s) => s.setScrollDirection);

  // Palette swatch count lives in settings (resolved on the backend at
  // finalize) so the count survives restarts and crosses cleanly into the
  // overlay window without per-session event plumbing. The control here
  // just reads + patches that value.
  const captureSettings = useSettingsStore((s) => s.settings?.capture ?? null);
  const paletteCount = captureSettings?.paletteCount ?? DEFAULT_PALETTE_COUNT;
  const settingsReady = captureSettings !== null;
  const patchSettings = useSettingsPatch();
  const isPalette =
    captureType === "custom" && customMode === "palette-capture";
  // Scrolling-Window + Panoramic stitch frames along a chosen axis; the
  // direction picker sets it (and, for Panoramic, which way the app
  // auto-scrolls).
  const isScrollMode =
    captureType === "custom" &&
    (customMode === "scrolling-window" || customMode === "panoramic");

  const visible = visibleOptionKeys(captureType, customMode);
  const stateOf: Record<string, boolean> = {
    preview,
    clipboard,
    cursor,
    enhance,
    delay: delayEnabled,
  };

  return (
    <CollapsibleSection
      n={startIndex}
      title="Capture Options"
      actions={
        <button
          type="button"
          aria-label="Advanced settings"
          onClick={onOpenSettings}
          className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-[var(--color-hint)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
        >
          <Settings size={16} strokeWidth={1.75} />
        </button>
      }
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-0.5 rounded-[14px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-3 shadow-[var(--shadow-medium)] sm:grid-cols-2">
        {OPTIONS.filter((o) => visible.has(o.key)).map((o) => {
          const isDelay = o.key === "delay";
          const on = stateOf[o.key];
          const hint = OPTION_UNAVAILABLE_HINT[o.key];
          const disabled = hint !== undefined;

          return (
            <div
              key={o.key}
              title={disabled ? hint : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors",
                disabled
                  ? "opacity-60"
                  : "hover:bg-[color:var(--color-overlay-1)]"
              )}
            >
              <IconTile icon={o.icon} tint={o.tint} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[var(--color-ink)]">
                  {isDelay ? "Capture Delay" : o.label}
                </span>
                {isDelay ? (
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[var(--color-hint)]">
                    Wait
                    <DelayStepper
                      value={delaySeconds}
                      onChange={setDelaySeconds}
                      disabled={disabled || !on}
                    />
                    seconds before capturing
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--color-hint)]">
                    {o.desc}
                  </span>
                )}
              </span>
              <ToggleSwitch
                checked={on ?? false}
                onChange={(v) =>
                  isDelay
                    ? setDelayEnabled(v)
                    : setOption(
                        o.key as "preview" | "clipboard" | "cursor" | "enhance",
                        v
                      )
                }
                label={o.label}
                disabled={disabled}
              />
            </div>
          );
        })}

        {isPalette && (
          <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-[color:var(--color-overlay-1)]">
            <IconTile icon={Palette} tint="cool" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--color-ink)]">
                Palette Colors
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[var(--color-hint)]">
                Extract
                <SwatchCountStepper
                  value={paletteCount}
                  onChange={(n) =>
                    captureSettings &&
                    patchSettings({
                      capture: { ...captureSettings, paletteCount: n },
                    })
                  }
                  disabled={!settingsReady}
                />
                swatches
              </span>
            </span>
          </div>
        )}

        {isScrollMode && (
          <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-[color:var(--color-overlay-1)]">
            <IconTile icon={MoveVertical} tint="warm" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--color-ink)]">
                Scroll Direction
              </span>
              <span className="mt-0.5 block truncate text-[12px] text-[var(--color-hint)]">
                {customMode === "panoramic"
                  ? "Which way Clippity auto-scrolls"
                  : "Which way you'll scroll the content"}
              </span>
            </span>
            <ScrollDirectionPicker
              value={scrollDirection}
              onChange={setScrollDirection}
            />
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
