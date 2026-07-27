/**
 * Patch + persist + race-guard the in-flight settings updates.
 *
 * Optimistic flow: mutate the store immediately for snappy UI →
 * fire the IPC → on resolve, adopt the server response only if no
 * newer write is pending. Mirrors the legacy `saveTokenRef` pattern
 * but moved out of the panel component.
 */

import { useCallback, useRef } from "react";

import { updateSettings } from "@services/tauri/clients/settings";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { useSettingsStore } from "../state/settingsStore";
import type { Settings, SettingsPatch } from "../types";

function merge(
  current: Settings | null,
  patch: SettingsPatch
): Settings | null {
  if (!current) return null;
  return {
    general: patch.general ?? current.general,
    appearance: patch.appearance ?? current.appearance,
    notifications: patch.notifications ?? current.notifications,
    performance: patch.performance ?? current.performance,
    capture: patch.capture ?? current.capture,
    recording: patch.recording ?? current.recording,
    models: patch.models ?? current.models,
    shortcuts: patch.shortcuts ?? current.shortcuts,
  };
}

export function useSettingsPatch() {
  const setSettings = useSettingsStore((s) => s.setSettings);
  const tokenRef = useRef(0);

  return useCallback(
    (patch: SettingsPatch) => {
      const next = merge(useSettingsStore.getState().settings, patch);
      if (!next) {
        // Not yet hydrated — nothing to patch against. Drop the call
        // silently; the UI is gated on `settings === null` anyway.
        return;
      }
      const token = ++tokenRef.current;
      setSettings(next);
      void updateSettings(patch)
        .then((saved) => {
          if (token === tokenRef.current) setSettings(saved);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          void emitErrorToast(`Settings update failed: ${msg}`);
        });
    },
    [setSettings]
  );
}
