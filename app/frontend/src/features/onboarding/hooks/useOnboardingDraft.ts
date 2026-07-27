/**
 * Onboarding controller — owns the wizard's draft state and the
 * finalize/complete handshake.
 *
 * Design notes:
 * - The wizard previews choices LIVE: changing the theme or accent
 *   immediately fires a `useSettingsPatch` (so the dashboard's theme +
 *   accent re-render in real time — the user sees what they're
 *   choosing). The Storage step is held locally until "Get started"
 *   because writing an empty captures-dir each keystroke would spam
 *   `ensure_captures_dir_exists`.
 * - The `onboarded` flip happens ONLY in `complete()`. Until then the
 *   wizard stays mounted; if the user closes the window mid-flow,
 *   their previewed theme/accent persist (matches the legacy behaviour
 *   — accidental theme picks survive a relaunch) and the wizard
 *   re-opens on next launch because `onboarded` is still false.
 * - The "Browse…" picker uses `@tauri-apps/plugin-dialog` — already on
 *   the workspace, matches the Settings panel's CapturesDirField path.
 */

import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useSettingsPatch } from "@features/settings";
import {
  getDefaultCapturesDir,
  type Settings,
  type ThemePref,
} from "@services/tauri/clients/settings";
import { emitErrorToast } from "@services/tauri/clients/toast";

import type { StepIndex } from "../types";

interface UseOnboardingDraftArgs {
  /** Current settings snapshot — provides initial values + lives mirror. */
  settings: Settings;
  /** Called after `complete()` successfully flips `onboarded = true`. */
  onComplete(): void;
}

export interface OnboardingDraft {
  step: StepIndex;
  capturesDir: string;
  /** Resolved default path the backend would use if `capturesDir` stays
   *  empty. Empty string while the initial fetch is in flight. */
  defaultHint: string;
  theme: ThemePref;
  accent: string;
  saving: boolean;
  error: string | null;
  setCapturesDir(next: string): void;
  resetCapturesDir(): void;
  setTheme(next: ThemePref): void;
  setAccent(next: string): void;
  browse(): Promise<void>;
  next(): void;
  back(): void;
}

export function useOnboardingDraft({
  settings,
  onComplete,
}: UseOnboardingDraftArgs): OnboardingDraft {
  const patch = useSettingsPatch();

  const [step, setStep] = useState<StepIndex>(0);
  const [capturesDir, setCapturesDir] = useState(settings.general.capturesDir);
  const [defaultHint, setDefaultHint] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve the backend fallback once on mount. If the initial fetch
  // fails we leave the hint blank — the Storage step renders an em-dash
  // placeholder rather than a misleading "Default — <unknown>".
  useEffect(() => {
    let alive = true;
    void getDefaultCapturesDir()
      .then((dir) => {
        if (alive) setDefaultHint(dir);
      })
      .catch(() => {
        /* swallow — display falls back to em-dash */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Live preview: theme + accent flow into `settings.appearance` so
  // the dashboard re-renders as the user clicks. The Storage step is
  // explicitly NOT live (see header comment).
  const setTheme = useCallback(
    (next: ThemePref) => {
      patch({ appearance: { ...settings.appearance, theme: next } });
    },
    [patch, settings.appearance]
  );

  const setAccent = useCallback(
    (next: string) => {
      patch({ appearance: { ...settings.appearance, accent: next } });
    },
    [patch, settings.appearance]
  );

  const browse = useCallback(async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose where captures are stored",
        defaultPath: capturesDir || defaultHint || undefined,
      });
      if (typeof picked === "string") setCapturesDir(picked);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not open the folder picker"
      );
    }
  }, [capturesDir, defaultHint]);

  const resetCapturesDir = useCallback(() => setCapturesDir(""), []);

  const complete = useCallback(() => {
    setSaving(true);
    setError(null);
    try {
      patch({
        general: {
          ...settings.general,
          capturesDir: capturesDir.trim(),
          onboarded: true,
        },
      });
      onComplete();
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Could not save your choices";
      setError(msg);
      void emitErrorToast(`Onboarding failed: ${msg}`);
      setSaving(false);
    }
  }, [capturesDir, onComplete, patch, settings.general]);

  const next = useCallback(() => {
    if (step < 2) {
      setStep((step + 1) as StepIndex);
    } else {
      complete();
    }
  }, [step, complete]);

  const back = useCallback(() => {
    if (step > 0) setStep((step - 1) as StepIndex);
  }, [step]);

  return {
    step,
    capturesDir,
    defaultHint,
    theme: settings.appearance.theme,
    accent: settings.appearance.accent,
    saving,
    error,
    setCapturesDir,
    resetCapturesDir,
    setTheme,
    setAccent,
    browse,
    next,
    back,
  };
}
