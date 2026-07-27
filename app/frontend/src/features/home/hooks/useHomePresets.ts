/**
 * Presets for the Home "Pinned presets" card.
 *
 * Fetches the preset list on mount and keeps it live via
 * `clippity://presets/changed` (emitted after any create / update /
 * delete). Returns the first few for the card; "Manage" jumps to the
 * full Presets view. Errors leave the list empty.
 */

import { useEffect, useState } from "react";

import {
  onPresetsChanged,
  presetsList,
  type CapturePreset,
} from "@services/tauri/clients/presets";

const PINNED_COUNT = 3;

export interface HomePresets {
  presets: CapturePreset[];
  loading: boolean;
}

export function useHomePresets(): HomePresets {
  const [presets, setPresets] = useState<CapturePreset[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void presetsList()
      .then((list) => {
        if (!cancelled) setPresets(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setPresets([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // The backend emits the full list on every change — replace wholesale.
    const unsub = onPresetsChanged((list) => setPresets(list ?? []));
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return { presets: presets.slice(0, PINNED_COUNT), loading };
}
