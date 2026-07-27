import {
  Gauge,
  Mic,
  MousePointer2,
  Settings,
  SquareDashed,
  Volume2,
} from "lucide-react";

import { useSettingsPatch, useSettingsStore } from "@features/settings";
import { Stepper, ToggleSwitch } from "@shared/ui";
import { cn } from "@shared/lib/cn";

import { useCaptureStore } from "../state/captureStore";
import { visibleRecordOptionKeys } from "../recordModes";
import type { ModeIcon, ModeTint } from "../types";
import { CollapsibleSection } from "./CollapsibleSection";
import { IconTile } from "./IconTile";

/** Frame-rate envelopes, mirroring `domain::recorder::{MP4,GIF}_FPS_*`.
 *  GIF's ceiling is lower because it stores delays in centiseconds. */
const FPS_RANGE = {
  mp4: { min: 10, max: 60, fallback: 30 },
  gif: { min: 5, max: 30, fallback: 15 },
} as const;

interface OptionDef {
  key: "microphone" | "systemAudio" | "cursor" | "outline" | "fps";
  label: string;
  desc: string;
  icon: ModeIcon;
  tint: ModeTint;
}

const OPTIONS: readonly OptionDef[] = [
  {
    key: "microphone",
    label: "Record Microphone",
    desc: "Mix your microphone into the recording",
    icon: Mic,
    tint: "warm",
  },
  {
    key: "systemAudio",
    label: "Record System Audio",
    desc: "Mix in what your computer is playing",
    icon: Volume2,
    tint: "cool",
  },
  {
    key: "cursor",
    label: "Record Cursor",
    desc: "Include the mouse pointer in each frame",
    icon: MousePointer2,
    tint: "warm",
  },
  {
    key: "outline",
    label: "Outline Recorded Area",
    desc: "Show a border around what's being recorded",
    icon: SquareDashed,
    tint: "cool",
  },
  {
    key: "fps",
    label: "Frame Rate",
    desc: "Frames captured per second",
    icon: Gauge,
    tint: "cool",
  },
];

interface RecordOptionsPanelProps {
  startIndex?: number;
  onOpenSettings: () => void;
}

/**
 * The Record screen's options panel — the counterpart to
 * `CaptureOptionsPanel`, and deliberately the same shape: icon-tiled
 * rows, per-mode visibility, a Settings shortcut in the header.
 *
 * **These rows edit Settings → Recording directly**, rather than a
 * per-session copy. The recorder can also be started from the Home
 * launcher and from a hotkey, neither of which passes through this
 * screen; if the panel held its own session state, a microphone
 * switched on here would silently not apply to those. Same precedent as
 * the palette swatch count in `CaptureOptionsPanel`.
 *
 * Frame rate is one control backed by two stored values — `videoFps`
 * and `gifFps` — because the usable ranges differ enough that carrying
 * one number across a format switch would land outside the legal range
 * (the backend clamps, but the user would see their setting change on
 * its own).
 */
export function RecordOptionsPanel({
  startIndex = 3,
  onOpenSettings,
}: RecordOptionsPanelProps) {
  const format = useCaptureStore((s) => s.recordFormat);
  const recording = useSettingsStore((s) => s.settings?.recording ?? null);
  const patch = useSettingsPatch();

  const ready = recording !== null;
  const range = FPS_RANGE[format];
  const fps = !recording
    ? range.fallback
    : format === "gif"
      ? recording.gifFps
      : recording.videoFps;

  const visible = visibleRecordOptionKeys(format);
  const stateOf: Record<string, boolean> = {
    microphone: recording?.microphone ?? false,
    systemAudio: recording?.systemAudio ?? false,
    cursor: recording?.cursor ?? false,
    outline: recording?.outline ?? true,
  };

  const update = (next: Partial<NonNullable<typeof recording>>) => {
    if (!recording) return;
    patch({ recording: { ...recording, ...next } });
  };

  return (
    <CollapsibleSection
      n={startIndex}
      title="Recording Options"
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
          const isFps = o.key === "fps";
          return (
            <div
              key={o.key}
              className={cn(
                "flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors",
                ready
                  ? "hover:bg-[color:var(--color-overlay-1)]"
                  : "opacity-60"
              )}
            >
              <IconTile icon={o.icon} tint={o.tint} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[var(--color-ink)]">
                  {o.label}
                </span>
                {isFps ? (
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[var(--color-hint)]">
                    Capture
                    <Stepper
                      value={fps}
                      min={range.min}
                      max={range.max}
                      disabled={!ready}
                      onChange={(next) =>
                        update(
                          format === "gif"
                            ? { gifFps: next }
                            : { videoFps: next }
                        )
                      }
                      label="Frame rate"
                    />
                    frames per second
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--color-hint)]">
                    {o.desc}
                  </span>
                )}
              </span>
              {isFps ? null : (
                <ToggleSwitch
                  checked={stateOf[o.key] ?? false}
                  disabled={!ready}
                  onChange={(v) =>
                    update({ [o.key]: v } as Partial<
                      NonNullable<typeof recording>
                    >)
                  }
                  label={o.label}
                />
              )}
            </div>
          );
        })}
      </div>

      {format === "gif" && (
        <p className="mt-2 px-1 text-[11.5px] text-[var(--color-hint)]">
          GIFs are silent and stop after a minute. Record video for
          anything longer or with sound.
        </p>
      )}
    </CollapsibleSection>
  );
}
