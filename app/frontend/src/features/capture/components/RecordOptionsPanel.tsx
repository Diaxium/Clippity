import {
  Camera,
  ClipboardCopy,
  Gauge,
  Layers,
  Mic,
  Monitor,
  MousePointer2,
  Settings,
  SquareDashed,
  Volume2,
} from "lucide-react";

import { useSettingsPatch, useSettingsStore } from "@features/settings";
import { Select, Stepper, ToggleSwitch } from "@shared/ui";
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

/** Mirrors `domain::recorder::RESOLUTION_SOURCE` — "encode what was
 *  captured", and the default. Local rather than imported from Settings
 *  for the same reason `FPS_RANGE` is: this feature does not reach into
 *  another's constants. */
const RESOLUTION_SOURCE = 0;

/** Encoder-quality steps, mirroring `domain::recorder::RecorderQuality`.
 *  Shorter labels than Settings uses — this row sits in a two-column
 *  grid, not a full-width settings list. */
const QUALITY_OPTIONS = [
  { value: "efficient", label: "Efficient" },
  { value: "balanced", label: "Balanced" },
  { value: "high", label: "High" },
];

/** Gain envelope, mirroring `domain::recorder::GAIN_PCT_*`. */
const GAIN_MAX_PCT = 200;
const GAIN_DEFAULT_PCT = 100;

/** Corner labels for the sources summary, matching the rects Settings'
 *  `CORNER_PRESETS` writes. Read-only here — the Record screen
 *  summarises sources, it does not position them. */
const CORNERS: readonly { x: number; y: number; label: string }[] = [
  { x: 0.03, y: 0.04, label: "top left" },
  { x: 0.72, y: 0.04, label: "top right" },
  { x: 0.03, y: 0.71, label: "bottom left" },
  { x: 0.72, y: 0.71, label: "bottom right" },
];

/** The heights offered on the Record screen, matching Settings →
 *  Recording. Shrinks only — a region shorter than the chosen height is
 *  left alone rather than upscaled. */
const RESOLUTION_OPTIONS = [
  { value: String(RESOLUTION_SOURCE), label: "Same as source" },
  { value: "2160", label: "2160p (4K)" },
  { value: "1440", label: "1440p (QHD)" },
  { value: "1080", label: "1080p (Full HD)" },
  { value: "720", label: "720p (HD)" },
  { value: "480", label: "480p" },
];

interface OptionDef {
  key:
    | "microphone"
    | "systemAudio"
    | "cursor"
    | "outline"
    | "clipboard"
    | "fps"
    | "resolution"
    | "quality"
    | "sources";
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
    key: "clipboard",
    label: "Copy to Clipboard",
    desc: "Paste the finished clip straight into a chat",
    icon: ClipboardCopy,
    tint: "warm",
  },
  {
    key: "fps",
    label: "Frame Rate",
    desc: "Frames captured per second",
    icon: Gauge,
    tint: "cool",
  },
  {
    key: "resolution",
    label: "Resolution",
    desc: "Scale the recording down before encoding",
    icon: Monitor,
    tint: "warm",
  },
  {
    key: "quality",
    label: "Quality",
    desc: "How many bits each frame gets",
    icon: Layers,
    tint: "cool",
  },
  {
    key: "sources",
    label: "Sources",
    desc: "Draw a camera or an image over the recording",
    icon: Camera,
    tint: "warm",
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
 *
 * Resolution needs no such split, and is hidden for GIF rather than
 * disabled: GIF's pixel budget is under every height on the menu, so the
 * control could not change the file either way.
 *
 * **Audio levels appear under an input once it is on.** The level is a
 * decision you make before pressing Record, not during — the HUD's
 * sliders exist for the during case — and a row that showed a slider for
 * a microphone nobody is recording would be noise.
 *
 * **Sources are summarised here, not edited here.** A full editor would
 * be a second copy of Settings' `SourcesCard` in a narrower space, and
 * positioning wants room this two-column grid does not have. The row
 * says what is configured, switches all of it on or off, and hands over
 * to Settings to change it (ADR 0033).
 *
 * Not surfaced at all: bitrate override, keyframe interval and the
 * hardware-encoder switch. Those tune a *machine* rather than a
 * recording — you set them once after looking at a bad file, not before
 * each session — so they stay in Settings → Recording.
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
    clipboard: recording?.clipboard ?? false,
  };

  const update = (next: Partial<NonNullable<typeof recording>>) => {
    if (!recording) return;
    patch({ recording: { ...recording, ...next } });
  };

  const sources = recording?.sources ?? [];
  const sourcesOn = sources.some((s) => s.enabled ?? true);

  /** Turn every source on or off at once.
   *
   *  A master switch rather than per-source rows: this panel summarises
   *  sources, and `enabled` is preserved per source in Settings, so
   *  flipping it back on restores exactly what was configured. */
  const toggleSources = (on: boolean) =>
    update({ sources: sources.map((s) => ({ ...s, enabled: on })) });

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
          const isResolution = o.key === "resolution";
          const isQuality = o.key === "quality";
          const isSources = o.key === "sources";
          // Audio rows carry a level slider instead of their
          // description once the input is on — the level is the thing
          // you set before pressing Record, and the description has
          // already done its job by then.
          const isAudio = o.key === "microphone" || o.key === "systemAudio";
          const gainKey =
            o.key === "microphone" ? "microphoneGainPct" : "systemGainPct";
          const showGain = isAudio && (stateOf[o.key] ?? false);
          const hasToggle = !isFps && !isResolution && !isQuality;
          return (
            <div
              key={o.key}
              className={cn(
                "flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors",
                ready ? "hover:bg-[color:var(--color-overlay-1)]" : "opacity-60"
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
                ) : showGain ? (
                  <span className="mt-0.5 flex items-center gap-2 text-[12px] text-[var(--color-hint)]">
                    <input
                      type="range"
                      className="clippity-slider h-1 w-full min-w-0 flex-1"
                      min={0}
                      max={GAIN_MAX_PCT}
                      step={5}
                      disabled={!ready}
                      value={recording?.[gainKey] ?? GAIN_DEFAULT_PCT}
                      aria-label={`${o.label} level`}
                      onChange={(e) =>
                        update({
                          [gainKey]: Number(e.currentTarget.value),
                        } as Partial<NonNullable<typeof recording>>)
                      }
                    />
                    <span className="w-9 shrink-0 text-right font-mono tabular-nums">
                      {recording?.[gainKey] ?? GAIN_DEFAULT_PCT}%
                    </span>
                  </span>
                ) : isSources ? (
                  <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[var(--color-hint)]">
                    <span className="min-w-0 truncate">
                      {summariseSources(sources)}
                    </span>
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="focus-ring shrink-0 rounded px-1 font-medium text-[var(--color-accent)] transition-colors hover:underline"
                    >
                      {sources.length > 0 ? "Edit" : "Add"}
                    </button>
                  </span>
                ) : (
                  <span className="mt-0.5 block truncate text-[12px] text-[var(--color-hint)]">
                    {o.desc}
                  </span>
                )}
              </span>
              {isResolution && (
                <Select
                  value={String(recording?.maxHeight ?? RESOLUTION_SOURCE)}
                  options={RESOLUTION_OPTIONS}
                  disabled={!ready}
                  ariaLabel="Resolution"
                  onChange={(height) => update({ maxHeight: Number(height) })}
                />
              )}
              {isQuality && (
                <Select
                  value={recording?.encoding?.quality ?? "balanced"}
                  options={QUALITY_OPTIONS}
                  disabled={!ready}
                  ariaLabel="Video quality"
                  onChange={(quality) =>
                    update({
                      encoding: {
                        ...(recording?.encoding ?? {}),
                        quality: quality as "efficient" | "balanced" | "high",
                      },
                    })
                  }
                />
              )}
              {isSources && (
                <ToggleSwitch
                  checked={sourcesOn}
                  // Nothing to switch on when nothing is configured —
                  // the Add shortcut beside it is the way in.
                  disabled={!ready || sources.length === 0}
                  onChange={toggleSources}
                  label="Draw sources over the recording"
                />
              )}
              {hasToggle && !isSources && (
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
          GIFs are silent and stop after a minute. Record video for anything
          longer or with sound.
        </p>
      )}
    </CollapsibleSection>
  );
}

/**
 * One line describing what will be drawn over the recording.
 *
 * Names the corner rather than the pixel rect: the rect is normalized
 * and means nothing until a frame exists, whereas "bottom right" is true
 * whatever the user ends up pointing at. A rect that matches no corner
 * preset — a preset from a future build, a hand-edited settings file —
 * is described without one rather than guessed at.
 */
export function summariseSources(
  sources: readonly {
    kind: string;
    rect: { x: number; y: number };
    enabled?: boolean;
  }[]
): string {
  const live = sources.filter((s) => s.enabled ?? true);
  if (sources.length === 0) return "Nothing over the recording";
  if (live.length === 0) return `${sources.length} configured · all off`;

  const [first] = live;
  const label = first!.kind === "webcam" ? "Camera" : "Image";
  const corner = CORNERS.find(
    (c) =>
      Math.abs(c.x - first!.rect.x) < 0.001 &&
      Math.abs(c.y - first!.rect.y) < 0.001
  );
  const where = corner ? ` ${corner.label}` : "";
  const rest = live.length - 1;
  return rest > 0 ? `${label}${where} +${rest} more` : `${label}${where}`;
}
