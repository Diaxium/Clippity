import { useEffect } from "react";

import { useCaptureStore } from "../state/captureStore";

const TEXT_INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

/**
 * Space-bar fires the supplied trigger when the user isn't typing
 * into a control. Reads `nav` from the store at the time of each
 * keypress, so the listener doesn't re-bind when the user clicks
 * between sidebar tabs.
 */
export function useSpaceTrigger(onTrigger: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useCaptureStore.getState().nav !== "capture") return;
      if (e.code !== "Space" && e.key !== " ") return;
      const tag = document.activeElement?.tagName ?? "";
      if (TEXT_INPUT_TAGS.has(tag)) return;
      e.preventDefault();
      onTrigger();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onTrigger]);
}
