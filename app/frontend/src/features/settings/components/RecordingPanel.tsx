import { useEffect, useState } from "react";

import { Select, Stepper, TickedSlider, ToggleSwitch } from "@shared/ui";
import type { SelectOption } from "@shared/ui";

import { listAudioDevices } from "@services/tauri/clients/recorder";

import {
  BITRATE_MAX_MBPS,
  BITRATE_MIN_MBPS,
  GAIN_MAX_PCT,
  GAIN_MIN_PCT,
  GAIN_STEP_PCT,
  GAIN_TICK_STEP_PCT,
  GIF_FPS_MAX,
  GIF_FPS_MIN,
  KEYFRAME_SECONDS_MAX,
  KEYFRAME_SECONDS_MIN,
  QUALITY_OPTIONS,
  RATE_CONTROL_OPTIONS,
  RESOLUTION_OPTIONS,
  RESOLUTION_SOURCE,
  VIDEO_FPS_MAX,
  VIDEO_FPS_MIN,
} from "../constants";
import type { RecordingSettings } from "../types";

/** Bits per megabit — the bitrate override is stored in bits per second
 *  (what Media Foundation wants) and typed in megabits (what a person
 *  reasons in). */
const BITS_PER_MBIT = 1_000_000;

/** What the bitrate field shows before it is switched on, and the value
 *  switching it on commits. A reasonable 1080p30 starting point.
 *
 *  Shown rather than a disabled 0 — the field's own minimum is 2, so a
 *  0 reads as broken, and a number that jumps the instant you enable the
 *  toggle reads as the toggle having done something it didn't. */
const DEFAULT_FIXED_MBPS = 8;
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";
import { SourcesCard } from "./SourcesCard";

/** Sentinel for "follow whatever Windows is using". */
const SYSTEM_DEFAULT = "";

interface RecordingPanelProps {
  value: RecordingSettings;
  onChange(next: RecordingSettings): void;
}

/**
 * Settings → Recording (ADR 0031). Edits the defaults every recording
 * session starts from — there is no per-session options panel for the
 * recorder the way there is for captures, because the launcher fires
 * immediately, so these *are* the controls.
 *
 * Both audio inputs ship off. A screen recorder that starts listening
 * to the room, or picks up whatever music is playing, the first time
 * someone tries it is a privacy surprise; turning it on is a decision
 * the user should make once, here, deliberately.
 *
 * The two level sliders set what a session *starts* at. Moving one
 * mid-recording is the HUD's job and does not write back here — a level
 * nudged for one awkward recording shouldn't become the level every
 * future recording begins at.
 *
 * **Advanced encoding is a separate card, not a disclosure.** Everything
 * in it is a real answer to "why is this file that size" or "why does
 * this recording look wrong", so hiding it behind a twisty would bury
 * the controls at exactly the moment someone goes looking for them. The
 * ordinary path is the Quality card above, which is three rows.
 */
export function RecordingPanel({ value, onChange }: RecordingPanelProps) {
  const mics = useAudioDevices(false);
  const outputs = useAudioDevices(true);

  const encoding = value.encoding;
  const patchEncoding = (next: Partial<typeof encoding>) =>
    onChange({ ...value, encoding: { ...encoding, ...next } });

  // A null/absent override means "derive from the quality step". The
  // toggle and the number are two controls over one field, rather than a
  // magic sentinel inside the number.
  const fixedBitrate = (encoding.bitrateBps ?? 0) > 0;
  const bitrateMbps = fixedBitrate
    ? Math.round((encoding.bitrateBps ?? 0) / BITS_PER_MBIT)
    : DEFAULT_FIXED_MBPS;

  return (
    <>
      <SectionCard title="Audio">
        <Row
          label="Record microphone"
          description="Mix your microphone into recordings. Off by default."
          control={
            <ToggleSwitch
              checked={value.microphone}
              onChange={(microphone) => onChange({ ...value, microphone })}
              label="Record microphone"
            />
          }
        />
        <Row
          label="Microphone"
          description="Which input to record from. Follows the system default unless pinned."
          control={
            <Select
              value={value.microphoneDevice ?? SYSTEM_DEFAULT}
              options={mics}
              // Disabled rather than hidden: seeing which microphone
              // *would* be used is the thing that tells you whether
              // turning the toggle on is safe.
              disabled={!value.microphone}
              ariaLabel="Microphone"
              onChange={(id) =>
                onChange({
                  ...value,
                  microphoneDevice: id === SYSTEM_DEFAULT ? null : id,
                })
              }
            />
          }
        />
        <Row
          label="Microphone level"
          description="How loud your microphone is in the mix. Adjustable mid-recording from the recording bar."
          control={
            <TickedSlider
              value={value.microphoneGainPct}
              min={GAIN_MIN_PCT}
              max={GAIN_MAX_PCT}
              step={GAIN_STEP_PCT}
              tickStep={GAIN_TICK_STEP_PCT}
              disabled={!value.microphone}
              onChange={(microphoneGainPct) =>
                onChange({ ...value, microphoneGainPct })
              }
              ariaLabel="Microphone level"
              formatValue={(v) => `${v}%`}
            />
          }
        />
        <Row
          label="Record system audio"
          description="Mix in what your computer is playing. Off by default."
          control={
            <ToggleSwitch
              checked={value.systemAudio}
              onChange={(systemAudio) => onChange({ ...value, systemAudio })}
              label="Record system audio"
            />
          }
        />
        <Row
          label="Output device"
          description="Which output to capture. Follows the system default unless pinned."
          control={
            <Select
              value={value.systemDevice ?? SYSTEM_DEFAULT}
              options={outputs}
              disabled={!value.systemAudio}
              ariaLabel="Output device"
              onChange={(id) =>
                onChange({
                  ...value,
                  systemDevice: id === SYSTEM_DEFAULT ? null : id,
                })
              }
            />
          }
        />
        <Row
          label="System audio level"
          description="How loud your computer's own sound is in the mix. Pull this down when narrating over a video."
          control={
            <TickedSlider
              value={value.systemGainPct}
              min={GAIN_MIN_PCT}
              max={GAIN_MAX_PCT}
              step={GAIN_STEP_PCT}
              tickStep={GAIN_TICK_STEP_PCT}
              disabled={!value.systemAudio}
              onChange={(systemGainPct) =>
                onChange({ ...value, systemGainPct })
              }
              ariaLabel="System audio level"
              formatValue={(v) => `${v}%`}
            />
          }
        />
      </SectionCard>

      <SectionCard title="Quality">
        <Row
          label="Video quality"
          description="How many bits each frame gets. The target scales with resolution and frame rate, so this stays meaningful whatever you record."
          control={
            <Select
              value={encoding.quality ?? "balanced"}
              options={QUALITY_OPTIONS}
              ariaLabel="Video quality"
              onChange={(quality) =>
                patchEncoding({
                  quality: quality as typeof encoding.quality,
                })
              }
            />
          }
        />
        <Row
          label="Resolution"
          description="Scale recordings down to this height before encoding. Keeps the aspect ratio, and never enlarges a smaller area."
          control={
            <Select
              value={String(value.maxHeight ?? RESOLUTION_SOURCE)}
              options={RESOLUTION_OPTIONS.map((o) => ({
                value: String(o.value),
                label: o.label,
              }))}
              ariaLabel="Resolution"
              onChange={(height) =>
                onChange({ ...value, maxHeight: Number(height) })
              }
            />
          }
        />
        <Row
          label="Video frame rate"
          description="Frames per second for video recordings. Higher is smoother and larger."
          control={
            <Stepper
              value={value.videoFps}
              min={VIDEO_FPS_MIN}
              max={VIDEO_FPS_MAX}
              onChange={(videoFps) => onChange({ ...value, videoFps })}
              label="Video frame rate"
            />
          }
        />
        <Row
          label="GIF frame rate"
          description="Kept separate from video — GIF stores delays in hundredths of a second, so its usable range is lower."
          control={
            <Stepper
              value={value.gifFps}
              min={GIF_FPS_MIN}
              max={GIF_FPS_MAX}
              onChange={(gifFps) => onChange({ ...value, gifFps })}
              label="GIF frame rate"
            />
          }
        />
        <Row
          label="Show cursor"
          description="Include the mouse pointer in recorded frames."
          control={
            <ToggleSwitch
              checked={value.cursor}
              onChange={(cursor) => onChange({ ...value, cursor })}
              label="Show cursor"
            />
          }
        />
        <Row
          label="Outline the recorded area"
          description="Draw a border around what's being recorded while the session runs. It never appears in the recording."
          control={
            <ToggleSwitch
              checked={value.outline}
              onChange={(outline) => onChange({ ...value, outline })}
              label="Outline the recorded area"
            />
          }
        />
        <Row
          label="Copy finished clips to the clipboard"
          description="Paste a recording straight into a chat or a folder. The clipboard holds a link to the file, so moving or deleting the clip breaks the paste."
          control={
            <ToggleSwitch
              checked={value.clipboard}
              onChange={(clipboard) => onChange({ ...value, clipboard })}
              label="Copy finished clips to the clipboard"
            />
          }
        />
      </SectionCard>

      <SourcesCard
        value={value.sources}
        onChange={(sources) => onChange({ ...value, sources })}
      />

      <SectionCard title="Advanced encoding">
        <Row
          label="Rate control"
          description="Variable lets still stretches of the screen cost almost nothing, which is most of a screen recording. Constant trades that for a predictable size per minute."
          control={
            <Select
              value={encoding.rateControl ?? "variable"}
              options={RATE_CONTROL_OPTIONS}
              ariaLabel="Rate control"
              onChange={(rateControl) =>
                patchEncoding({
                  rateControl: rateControl as typeof encoding.rateControl,
                })
              }
            />
          }
        />
        <Row
          label="Use a fixed bitrate"
          description="Ignore the quality setting and target a specific bitrate instead. Only worth it when something downstream requires a known number."
          control={
            <ToggleSwitch
              checked={fixedBitrate}
              onChange={(on) =>
                patchEncoding({
                  bitrateBps: on ? DEFAULT_FIXED_MBPS * BITS_PER_MBIT : null,
                })
              }
              label="Use a fixed bitrate"
            />
          }
        />
        <Row
          label="Bitrate"
          description="Megabits per second. Higher is sharper and larger; the backend clamps this to a workable range."
          control={
            <Stepper
              value={bitrateMbps}
              min={BITRATE_MIN_MBPS}
              max={BITRATE_MAX_MBPS}
              disabled={!fixedBitrate}
              onChange={(mbps) =>
                patchEncoding({ bitrateBps: mbps * BITS_PER_MBIT })
              }
              label="Bitrate in megabits per second"
            />
          }
        />
        <Row
          label="Keyframe interval"
          description="Seconds between the frames a player can jump straight to. Shorter makes scrubbing in Studio land where you expect; longer compresses a static screen better."
          control={
            <Stepper
              value={encoding.keyframeSeconds ?? 2}
              min={KEYFRAME_SECONDS_MIN}
              max={KEYFRAME_SECONDS_MAX}
              onChange={(keyframeSeconds) => patchEncoding({ keyframeSeconds })}
              label="Keyframe interval in seconds"
            />
          }
        />
        <Row
          label="Use the GPU's encoder"
          description="On by default — software encoding can't keep up at 4K60. Turn it off if recordings look worse than they should; a few graphics drivers encode poorly."
          control={
            <ToggleSwitch
              checked={encoding.preferHardware ?? true}
              onChange={(preferHardware) => patchEncoding({ preferHardware })}
              label="Use the GPU's encoder"
            />
          }
        />
      </SectionCard>
    </>
  );
}

/**
 * Audio endpoints for one side of the graph, always led by a "System
 * default" entry.
 *
 * Enumeration failing is not worth surfacing: the list falls back to
 * just the default option, which is exactly what an un-pinned setting
 * already means. A device that has since been unplugged simply stops
 * appearing — the backend falls back to the default for a pinned id it
 * can no longer resolve, so the recording still happens.
 */
function useAudioDevices(system: boolean): SelectOption[] {
  const [options, setOptions] = useState<SelectOption[]>([
    { value: SYSTEM_DEFAULT, label: "System default" },
  ]);

  useEffect(() => {
    let live = true;
    void listAudioDevices(system)
      .then((devices) => {
        if (!live) return;
        setOptions([
          { value: SYSTEM_DEFAULT, label: "System default" },
          ...devices.map((d) => ({
            value: d.id,
            label: d.isDefault ? `${d.name} (default)` : d.name,
          })),
        ]);
      })
      .catch(() => {
        /* Keep the default-only list. */
      });
    return () => {
      live = false;
    };
  }, [system]);

  return options;
}
