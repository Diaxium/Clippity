/**
 * Preset create/edit form state. Holds a flat, UI-friendly draft and
 * converts it to/from the wire shapes. Pure converters (`draftToInput`,
 * `draftFromPreset`) are exported so they can be unit-tested without
 * rendering the form.
 *
 * **One draft covers both preset kinds.** A recording preset and a
 * capture preset share a name, a target and a save directory, and differ
 * in the handful of fields below the `mode` switch. Two drafts would
 * mean two forms and two round-trips for a user toggling between them
 * mid-edit — this way flipping `mode` keeps everything the two have in
 * common.
 */

import { useCallback, useState } from "react";

import type {
  CapturePreset,
  PresetInput,
} from "@services/tauri/clients/presets";
import { isRecordingPreset } from "@services/tauri/clients/presets";
import type {
  RecorderFormat,
  RecorderTarget,
} from "@services/tauri/clients/recorder";
import type { PresetCaptureType } from "@shared/lib/captureTypeMeta";

/** What a preset does when it runs. */
export type PresetMode = "capture" | "record";

export interface PresetDraft {
  name: string;
  mode: PresetMode;
  /** Shared by both modes: `PresetCaptureType` and `RecorderTarget` are
   *  the same three values, which is why the target tiles don't change
   *  when the mode does. */
  type: PresetCaptureType;
  clipboard: boolean;
  cursor: boolean;
  openEditor: boolean;
  /** null = save to the default captures dir. */
  saveDir: string | null;
  // ---- recording-only ----
  format: RecorderFormat;
  fps: number;
  /** 0 = encode at the captured size. */
  maxHeight: number;
  microphone: boolean;
  systemAudio: boolean;
}

const EMPTY: PresetDraft = {
  name: "",
  mode: "capture",
  type: "region",
  clipboard: true,
  cursor: false,
  openEditor: false,
  saveDir: null,
  format: "mp4",
  fps: 30,
  maxHeight: 0,
  microphone: false,
  systemAudio: false,
};

/** The three targets both modes share. */
function targetOf(value: string): PresetCaptureType {
  return (["fullscreen", "region", "window"] as const).includes(
    value as PresetCaptureType
  )
    ? (value as PresetCaptureType)
    : "region";
}

/** Build a draft from an existing preset (edit flow). */
export function draftFromPreset(p: CapturePreset): PresetDraft {
  if (isRecordingPreset(p.request)) {
    const r = p.request;
    return {
      ...EMPTY,
      name: p.name,
      mode: "record",
      type: targetOf(r.target),
      format: r.format,
      fps: r.fps ?? (r.format === "gif" ? 15 : 30),
      maxHeight: r.maxHeight ?? 0,
      microphone: r.audio?.microphone ?? false,
      systemAudio: r.audio?.system ?? false,
      cursor: r.toggles?.cursor ?? false,
      clipboard: r.toggles?.clipboard ?? false,
      saveDir: p.output.saveDir,
    };
  }
  return {
    ...EMPTY,
    name: p.name,
    mode: "capture",
    type: targetOf(p.request.type),
    clipboard: p.request.toggles.clipboard,
    cursor: p.request.toggles.cursor,
    openEditor: p.output.openEditor,
    saveDir: p.output.saveDir,
  };
}

/** Pure: a draft → the create/update request body (no id). */
export function draftToInput(d: PresetDraft): PresetInput {
  if (d.mode === "record") {
    return {
      name: d.name.trim(),
      request: {
        target: d.type as RecorderTarget,
        format: d.format,
        fps: d.fps,
        maxHeight: d.maxHeight,
        audio: {
          // GIF carries no audio track, so a preset must not claim one —
          // the backend empties it anyway, but a saved preset that says
          // "microphone" and records silence is a lie on disk.
          microphone: d.format === "gif" ? false : d.microphone,
          system: d.format === "gif" ? false : d.systemAudio,
        },
        toggles: {
          cursor: d.cursor,
          clicks: false,
          // The editor cannot open a video, so a recording preset never
          // hands one to it — see ADR 0031.
          preview: false,
          clipboard: d.clipboard,
        },
      },
      // `openEditor` is deliberately dropped for a recording: there is
      // nothing that could honour it. The editor hides the control too,
      // so this only ever discards a value left from a mode flip.
      output: { openEditor: false, saveDir: d.saveDir },
    };
  }

  return {
    name: d.name.trim(),
    request: {
      type: d.type,
      customMode: null,
      toggles: {
        preview: false,
        clipboard: d.clipboard,
        cursor: d.cursor,
        // Presets don't expose enhancement yet — it belongs with the
        // per-preset output settings in Presets v2.
        enhance: false,
      },
      delay: null,
      effect: null,
      share: null,
      outputDir: null,
    },
    output: { openEditor: d.openEditor, saveDir: d.saveDir },
  };
}

export function usePresetDraft(initial?: CapturePreset) {
  const [draft, setDraft] = useState<PresetDraft>(
    initial ? draftFromPreset(initial) : EMPTY
  );

  const set = useCallback(
    <K extends keyof PresetDraft>(key: K, value: PresetDraft[K]) =>
      setDraft((d) => {
        const next = { ...d, [key]: value };
        // GIF's frame-rate ceiling is half video's, so carrying a 60
        // across a format flip would save a preset the backend then
        // silently clamps — the user would see their setting change on
        // its own the next time they opened it.
        if (key === "format" && value === "gif") next.fps = Math.min(d.fps, 30);
        return next;
      }),
    []
  );

  const reset = useCallback(() => setDraft(EMPTY), []);

  return { draft, set, reset, valid: draft.name.trim().length > 0 };
}
