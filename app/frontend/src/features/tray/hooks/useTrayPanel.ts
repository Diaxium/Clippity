/**
 * Tray panel controller.
 *
 * Owns dismissal (Esc + the Close button), the focus-on-open behaviour,
 * the quick capture options (cursor / clipboard toggles + the Timed
 * delay modifier), and the action handlers wired to the panel's buttons.
 * The actions themselves are thin: each reuses an existing IPC client
 * (capture / overlay / countdown / dashboard) — the tray is a launcher,
 * not a second capture pipeline.
 *
 * Capture handlers `await hideTrayPanel()` BEFORE firing so the panel
 * can't appear in the shot (the backend hide settles the compositor
 * before resolving — the panel isn't a primary window, so the capture
 * pipeline won't hide it for us). Region/Window mirror the toggles to the
 * overlay first (`emitOverlayToggles`), exactly like `useCaptureWorkflow`,
 * so the overlay's bottom bar reflects the tray's choices.
 *
 * `preview` is held on (it's a no-op until the editor-preview port lands —
 * the capture window renders that toggle disabled for the same reason), so
 * only Cursor + Copy are user-facing.
 *
 * Timed is a modifier, not a mode: when enabled it applies to every quick
 * capture (Fullscreen / Region / Window / Repeat) via `runTimedGate`, which mirrors
 * `useCaptureWorkflow`'s delay branch — show the countdown HUD, then
 * proceed on tick-to-zero or bail on Esc. Sharing that one timing model
 * retires the earlier `timedPendingRef` interim that fired the shot on a
 * persistent `countdown/finished` listener (see
 * [ADR 0003](../../../../../docs/decisions/0003-tray-flyout-panel.md)).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { CaptureRequest } from "@services/tauri/clients/capture";
import { captureFullscreen } from "@services/tauri/clients/capture";
import {
  onCountdownCancelled,
  onCountdownFinished,
  startCountdown,
} from "@services/tauri/clients/countdown";
import { openDashboard } from "@services/tauri/clients/dashboard";
import {
  beginRegionCapture,
  emitOverlayToggles,
  recaptureLastRegion,
} from "@services/tauri/clients/overlay";
import {
  emitErrorToast,
  showCaptureWindow,
} from "@services/tauri/clients/toast";
import {
  hideTrayPanel,
  onTrayOpened,
  quitApp,
} from "@services/tauri/clients/tray";
import {
  runPreset as runPresetClient,
  type CapturePreset,
} from "@services/tauri/clients/presets";

/** The quick toggles the tray exposes. `cursor` / `clipboard` are
 *  mirrored to the overlay; `timed` arms the countdown delay modifier.
 *  (`preview` is held on — see the module doc.) */
export type TrayToggleKey = "cursor" | "clipboard" | "timed";

/** Selectable delays (seconds) for the Timed modifier. First entry is the
 *  default. */
export const TIMED_CHOICES = [3, 5, 10] as const;

/** Build a fullscreen capture request from the current quick toggles. */
function fullscreenRequest(
  cursor: boolean,
  clipboard: boolean
): CaptureRequest {
  return {
    type: "fullscreen",
    customMode: null,
    // The tray flyout is a quick-action surface — it exposes only
    // cursor/clipboard/timed, so enhancement stays off here and is
    // chosen per-capture in the capture window or the overlay.
    toggles: { preview: true, clipboard, cursor, enhance: false },
    delay: null,
    effect: null,
    share: null,
  };
}

export interface TrayActions {
  fullscreen: () => void;
  windowCapture: () => void;
  region: () => void;
  repeatLastRegion: () => void;
  openCaptureWindow: () => void;
  openLibrary: () => void;
  openEditor: () => void;
  openSettings: () => void;
  openRecent: (id: string) => void;
  runPreset: (preset: CapturePreset) => void;
  quit: () => void;
  dismiss: () => void;
}

export function useTrayPanel() {
  const panelRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);

  // Quick capture options. Local to the panel (its own window, so it
  // can't share the capture window's store); persists across open/close
  // because the backend only hides the panel, never unmounts it.
  const [cursor, setCursor] = useState(false);
  const [clipboard, setClipboard] = useState(false);
  const [timedEnabled, setTimedEnabled] = useState(false);
  const [timedSeconds, setTimedSeconds] = useState<number>(TIMED_CHOICES[0]);

  const setToggle = useCallback((key: TrayToggleKey, value: boolean) => {
    if (key === "cursor") setCursor(value);
    else if (key === "clipboard") setClipboard(value);
    else setTimedEnabled(value);
  }, []);

  // Delay modifier: when Timed is on, run the countdown HUD first and
  // resolve to `true` only if it ticks to zero (Esc → `false`, skip the
  // shot). When off, proceed immediately. Mirrors `useCaptureWorkflow`.
  const runTimedGate = useCallback(async (): Promise<boolean> => {
    if (!timedEnabled || timedSeconds <= 0) return true;
    try {
      await startCountdown(timedSeconds);
    } catch {
      return false; // HUD never showed — don't wait on an event that won't fire.
    }
    return (await waitForCountdownOutcome()) === "finished";
  }, [timedEnabled, timedSeconds]);

  const dismiss = useCallback(() => {
    void hideTrayPanel();
  }, []);

  const fullscreen = useCallback(async () => {
    await hideTrayPanel();
    if (!(await runTimedGate())) return;
    await captureFullscreen(fullscreenRequest(cursor, clipboard)).catch(() => {
      /* failures surface via the backend toast pipeline */
    });
  }, [cursor, clipboard, runTimedGate]);

  const region = useCallback(async () => {
    await hideTrayPanel();
    if (!(await runTimedGate())) return;
    // Mirror toggles so the overlay bottom bar matches, then open it —
    // same handshake as `useCaptureWorkflow`.
    await emitOverlayToggles({
      preview: true,
      clipboard,
      cursor,
      enhance: false,
    }).catch(() => {});
    await beginRegionCapture("region").catch(() => {});
  }, [cursor, clipboard, runTimedGate]);

  const windowCapture = useCallback(async () => {
    await hideTrayPanel();
    if (!(await runTimedGate())) return;
    await emitOverlayToggles({
      preview: true,
      clipboard,
      cursor,
      enhance: false,
    }).catch(() => {});
    await beginRegionCapture("window").catch(() => {});
  }, [cursor, clipboard, runTimedGate]);

  const repeatLastRegion = useCallback(async () => {
    await hideTrayPanel();
    if (!(await runTimedGate())) return;
    // No overlay: the backend crops the remembered rect straight out of a
    // fresh snapshot. It rejects when nothing is remembered or the
    // display layout changed since — surface that, since the user
    // clicked expecting a capture and would otherwise see nothing happen.
    await recaptureLastRegion({
      preview: true,
      clipboard,
      cursor,
      enhance: false,
    }).catch((err: unknown) => {
      void emitErrorToast(
        err instanceof Error ? err.message : "Nothing to recapture yet."
      );
    });
  }, [cursor, clipboard, runTimedGate]);

  const openCaptureWindow = useCallback(() => {
    void hideTrayPanel();
    void showCaptureWindow();
  }, []);

  const openLibrary = useCallback(() => {
    void hideTrayPanel();
    void openDashboard("library");
  }, []);

  const openEditor = useCallback(() => {
    void hideTrayPanel();
    void openDashboard("editor");
  }, []);

  const openSettings = useCallback(() => {
    void hideTrayPanel();
    void openDashboard("settings");
  }, []);

  const openRecent = useCallback((id: string) => {
    void hideTrayPanel();
    void openDashboard("editor", id);
  }, []);

  const runPreset = useCallback(async (preset: CapturePreset) => {
    // Hide first so the panel isn't in the shot (region presets open the
    // overlay; fullscreen presets capture immediately). `runPresetClient`
    // surfaces its own errors via the toast pipeline.
    await hideTrayPanel();
    await runPresetClient(preset);
  }, []);

  const quit = useCallback(() => {
    void quitApp();
  }, []);

  const actions: TrayActions = {
    fullscreen,
    windowCapture,
    region,
    repeatLastRegion,
    openCaptureWindow,
    openLibrary,
    openEditor,
    openSettings,
    openRecent,
    runPreset,
    quit,
    dismiss,
  };

  // Esc closes the panel — it's focused, so a window keydown suffices.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  // On each open, pull keyboard focus to the first action (fallback: the
  // panel root) so Tab lands sensibly and the focus ring is visible.
  useEffect(
    () =>
      onTrayOpened(() => {
        (firstActionRef.current ?? panelRef.current)?.focus();
      }),
    []
  );

  return {
    actions,
    panelRef,
    firstActionRef,
    toggles: { cursor, clipboard, timed: timedEnabled },
    setToggle,
    timedSeconds,
    setTimedSeconds,
  };
}

/**
 * Race the backend's `countdown/finished` and `countdown/cancelled`
 * events. Returns whichever fires first, then unsubscribes from both so a
 * late event doesn't leak listeners.
 *
 * Mirrors the identical helper in `useCaptureWorkflow`; kept module-local
 * (rather than hoisted into the IPC client) per that module's note — a
 * shared "wait then unsubscribe" wrapper invites copy-paste callers that
 * forget to clean up. The tray's delay gate and the capture window now
 * share one timing model.
 */
function waitForCountdownOutcome(): Promise<"finished" | "cancelled"> {
  return new Promise((resolve) => {
    let unsubFinished: (() => void) | null = null;
    let unsubCancelled: (() => void) | null = null;
    const cleanup = (result: "finished" | "cancelled") => {
      unsubFinished?.();
      unsubCancelled?.();
      resolve(result);
    };
    unsubFinished = onCountdownFinished(() => cleanup("finished"));
    unsubCancelled = onCountdownCancelled(() => cleanup("cancelled"));
  });
}
