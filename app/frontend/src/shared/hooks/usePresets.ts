/**
 * Shared read model for capture presets. Pulls the list once on mount
 * and mirrors `clippity://presets/changed` (the backend emits the full
 * list on every create / update / delete). Two consumers — the dashboard
 * manager (`features/presets`) and the tray's Presets section
 * (`features/tray`) — so it lives in `shared/` per FEATURE_RULES.
 */

import { useEffect, useState } from "react";

import { isTauriContext } from "@services/tauri";
import {
  onPresetsChanged,
  presetsList,
  type CapturePreset,
} from "@services/tauri/clients/presets";

export function usePresets(): { presets: CapturePreset[]; loading: boolean } {
  const [presets, setPresets] = useState<CapturePreset[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isTauriContext()) return;
    let mounted = true;
    setLoading(true);
    void presetsList()
      .then((p) => {
        if (mounted) setPresets(p);
      })
      .catch(() => {
        if (mounted) setPresets([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Live updates — the backend emits the full list, so just replace.
  useEffect(() => onPresetsChanged((p) => setPresets(p)), []);

  return { presets, loading };
}
