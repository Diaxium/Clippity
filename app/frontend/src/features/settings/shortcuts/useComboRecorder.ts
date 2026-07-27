/**
 * One-shot keyboard-combo recorder for the Shortcuts panel. While
 * `recording`, a capture-phase window listener swallows key events and
 * resolves the first non-modifier press to an author combo (via
 * {@link comboFromEvent}), hands it to `onCapture`, and stops.
 *
 * Escape cancels the recording without binding anything — so Escape is not
 * itself rebindable through the recorder (it's the universal "back out"
 * key; a binding that defaults to it is restored via Reset, not re-recorded).
 * The listener runs in the capture phase and stops propagation so a press
 * meant for the recorder never leaks to the app's own keybind handlers.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { comboFromEvent } from "@features/editor/keybinds/keybindUtils";

export interface ComboRecorder {
  recording: boolean;
  start(): void;
  cancel(): void;
}

export function useComboRecorder(
  onCapture: (combo: string) => void,
): ComboRecorder {
  const [recording, setRecording] = useState(false);
  // Hold the latest callback without re-installing the listener each render.
  const onCaptureRef = useRef(onCapture);
  onCaptureRef.current = onCapture;

  const start = useCallback(() => setRecording(true), []);
  const cancel = useCallback(() => setRecording(false), []);

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // The recorder owns every key while armed.
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;

      // Bare Escape cancels; Escape with a modifier is a real combo.
      const bareEscape =
        e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
      if (bareEscape) {
        setRecording(false);
        return;
      }

      const combo = comboFromEvent(e);
      if (!combo) return; // lone modifier — keep waiting for the main key
      setRecording(false);
      onCaptureRef.current(combo);
    };

    // Capture phase so the press never reaches the app's own handlers.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording]);

  return { recording, start, cancel };
}
