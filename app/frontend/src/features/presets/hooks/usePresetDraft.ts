/**
 * Preset create/edit form state. Holds a flat, UI-friendly draft and
 * converts it to/from the wire shapes. Pure converters (`draftToInput`,
 * `draftFromPreset`) are exported so they can be unit-tested without
 * rendering the form.
 */

import { useCallback, useState } from "react";

import type {
  CapturePreset,
  PresetInput,
} from "@services/tauri/clients/presets";
import type { PresetCaptureType } from "@shared/lib/captureTypeMeta";

export interface PresetDraft {
  name: string;
  type: PresetCaptureType;
  clipboard: boolean;
  cursor: boolean;
  openEditor: boolean;
  /** null = save to the default captures dir. */
  saveDir: string | null;
}

const EMPTY: PresetDraft = {
  name: "",
  type: "region",
  clipboard: true,
  cursor: false,
  openEditor: false,
  saveDir: null,
};

/** Build a draft from an existing preset (edit flow). */
export function draftFromPreset(p: CapturePreset): PresetDraft {
  return {
    name: p.name,
    type: (["fullscreen", "region", "window"] as const).includes(
      p.request.type as PresetCaptureType
    )
      ? (p.request.type as PresetCaptureType)
      : "region",
    clipboard: p.request.toggles.clipboard,
    cursor: p.request.toggles.cursor,
    openEditor: p.output.openEditor,
    saveDir: p.output.saveDir,
  };
}

/** Pure: a draft → the create/update request body (no id). */
export function draftToInput(d: PresetDraft): PresetInput {
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
      setDraft((d) => ({ ...d, [key]: value })),
    []
  );

  const reset = useCallback(() => setDraft(EMPTY), []);

  return { draft, set, reset, valid: draft.name.trim().length > 0 };
}
