import { ScrollDirectionPicker, Stepper, ToggleSwitch } from "@shared/ui";

import {
  CAPTURE_DELAY_MAX_S,
  CAPTURE_DELAY_MIN_S,
  PALETTE_COUNT_MAX,
  PALETTE_COUNT_MIN,
} from "../constants";
import type { CaptureSettings } from "../types";
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";

interface CapturePanelProps {
  value: CaptureSettings;
  onChange(next: CaptureSettings): void;
}

/**
 * Settings → Capture. Edits the persisted *defaults* a fresh capture
 * window opens with — the capture window seeds its per-session store
 * from these on launch (see `useCaptureDefaults`), so tweaking a toggle
 * here changes where every new capture session starts, while the
 * capture window's own options panel still lets the user override for
 * the current session without disturbing these defaults.
 */
export function CapturePanel({ value, onChange }: CapturePanelProps) {
  return (
    <>
      <SectionCard title="Default capture options">
        <Row
          label="Preview in editor"
          description="Open each new capture in the editor after taking it."
          control={
            <ToggleSwitch
              checked={value.preview}
              onChange={(preview) => onChange({ ...value, preview })}
              label="Preview in editor"
            />
          }
        />
        <Row
          label="Copy to clipboard"
          description="Copy each new capture to the clipboard automatically."
          control={
            <ToggleSwitch
              checked={value.clipboard}
              onChange={(clipboard) => onChange({ ...value, clipboard })}
              label="Copy to clipboard"
            />
          }
        />
        <Row
          label="Capture cursor"
          description="Include the mouse cursor in the capture."
          control={
            <ToggleSwitch
              checked={value.cursor}
              onChange={(cursor) => onChange({ ...value, cursor })}
              label="Capture cursor"
            />
          }
        />
        <Row
          label="Smart enhance"
          description="Auto-level and lightly sharpen the capture before saving."
          control={
            <ToggleSwitch
              checked={value.enhance}
              onChange={(enhance) => onChange({ ...value, enhance })}
              label="Smart enhance"
            />
          }
        />
      </SectionCard>

      <SectionCard title="Delay">
        <Row
          label="Capture delay"
          description="Wait a moment before capturing — time to set up the shot."
          control={
            <ToggleSwitch
              checked={value.delay}
              onChange={(delay) => onChange({ ...value, delay })}
              label="Capture delay"
            />
          }
        />
        <Row
          label="Delay length"
          description="How many seconds to count down before the capture fires."
          control={
            <span className="flex items-center gap-2 text-[12px] text-[var(--color-slate)]">
              <Stepper
                value={value.delaySeconds}
                onChange={(delaySeconds) =>
                  onChange({ ...value, delaySeconds })
                }
                min={CAPTURE_DELAY_MIN_S}
                max={CAPTURE_DELAY_MAX_S}
                disabled={!value.delay}
                label="Delay in seconds"
              />
              seconds
            </span>
          }
        />
      </SectionCard>

      <SectionCard title="Scrolling & panoramic">
        <Row
          label="Scroll direction"
          description="The default axis Scrolling-Window and Panoramic captures stitch along."
          control={
            <ScrollDirectionPicker
              value={value.scrollDirection}
              onChange={(scrollDirection) =>
                onChange({ ...value, scrollDirection })
              }
            />
          }
        />
      </SectionCard>

      <SectionCard title="Palette">
        <Row
          label="Palette colors"
          description="How many swatches a Palette capture extracts by default."
          control={
            <span className="flex items-center gap-2 text-[12px] text-[var(--color-slate)]">
              <Stepper
                value={value.paletteCount}
                onChange={(paletteCount) =>
                  onChange({ ...value, paletteCount })
                }
                min={PALETTE_COUNT_MIN}
                max={PALETTE_COUNT_MAX}
                label="Number of palette swatches"
              />
              swatches
            </span>
          }
        />
      </SectionCard>
    </>
  );
}
