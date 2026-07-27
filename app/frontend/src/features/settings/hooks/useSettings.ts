/**
 * Hydrate the settings store on mount + keep it in sync with backend
 * change events. Returns the current snapshot (or `null` while the
 * first fetch is in flight).
 *
 * Components that just need a derived value (e.g. `theme`) should
 * select from `useSettingsStore` directly to avoid re-renders on
 * unrelated section changes.
 */

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  getSettings,
  onSettingsChanged,
} from "@services/tauri/clients/settings";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { isTauriContext } from "@services/tauri";
import { setKeybindOverrides } from "@shared/keybinds/overrides";

import { useSettingsStore } from "../state/settingsStore";

export function useSettings() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

  // Keep the module-level keybind-override registry in step with the
  // persisted `shortcuts.overrides`, so the editor / library /
  // quick-capture registries resolve against the user's remaps the moment
  // settings hydrate or change. `setKeybindOverrides` self-guards on
  // value-equality, so this fires cheaply on every unrelated settings edit.
  useEffect(() => {
    setKeybindOverrides(settings?.shortcuts?.overrides);
  }, [settings?.shortcuts?.overrides]);

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void getSettings()
        .then((s) => {
          if (alive) setSettings(s);
        })
        .catch((err) => {
          // Settings load failure shouldn't blank the UI — render
          // against null (panels show their skeleton) and surface the
          // error through the toast pipeline so the user knows.
          const msg = err instanceof Error ? err.message : String(err);
          void emitErrorToast(`Failed to load settings: ${msg}`);
        });

    refresh();
    const unsubscribe = onSettingsChanged(setSettings);

    // Every window is created at startup and only hidden (never destroyed —
    // see the backend's `create_app_windows`). A hidden WebView2 page can
    // miss or defer the `settings/changed` broadcast, so a backgrounded
    // window holds a STALE snapshot: the dashboard re-shows the completed
    // onboarding wizard (its `onboarded` is still false), or a window comes
    // back with a stale accent/theme. Re-snapshot whenever this window is
    // revealed so the gate + all settings-derived UI are current.
    //
    // Two signals, because neither alone is reliable for these frameless,
    // transparent, boot-hidden windows:
    //   - Tauri `onFocusChanged` — authoritative when a hidden window is
    //     shown+focused (its DOM `visibilityState` may already read
    //     "visible", so `visibilitychange` never fires on show), and DOM
    //     focus events aren't reliably delivered to such a webview.
    //   - `document.visibilitychange` — covers minimize / occlusion, and is
    //     the only signal in the browser-preview / test build.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    let unlistenFocus: (() => void) | undefined;
    let cancelled = false;
    if (isTauriContext()) {
      void getCurrentWindow()
        .onFocusChanged(({ payload: focused }) => {
          if (focused) refresh();
        })
        .then((u) => {
          if (cancelled) u();
          else unlistenFocus = u;
        })
        .catch(() => {
          /* focus listener failed — visibilitychange remains the fallback */
        });
    }

    return () => {
      alive = false;
      cancelled = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      unlistenFocus?.();
    };
  }, [setSettings]);

  return settings;
}
