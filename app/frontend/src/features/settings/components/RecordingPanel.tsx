import { useEffect, useState } from "react";

import { Select, Stepper, ToggleSwitch } from "@shared/ui";
import type { SelectOption } from "@shared/ui";

import { listAudioDevices } from "@services/tauri/clients/recorder";

import {
  GIF_FPS_MAX,
  GIF_FPS_MIN,
  VIDEO_FPS_MAX,
  VIDEO_FPS_MIN,
} from "../constants";
import type { RecordingSettings } from "../types";
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";

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
 */
export function RecordingPanel({ value, onChange }: RecordingPanelProps) {
  const mics = useAudioDevices(false);
  const outputs = useAudioDevices(true);

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
      </SectionCard>

      <SectionCard title="Quality">
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
