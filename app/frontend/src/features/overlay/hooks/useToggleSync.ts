import { useEffect } from "react";

import { onOverlayToggles } from "@services/tauri/clients/overlay";
import { onOverlayRecordFormat } from "@services/tauri/clients/recorder";
import { onOverlayScrollDirection } from "@services/tauri/clients/scroll";

import { useOverlayStore } from "../state/overlayStore";

/**
 * Mirror the capture-window's options into the overlay store — the
 * toggles (preview / clipboard / cursor), the scroll direction, and the
 * recording format. Capture window broadcasts these before opening the
 * overlay (and on every flip), so the overlay's chrome shows what the
 * user pre-set.
 *
 * One-way sync: the overlay's own interactions write to its store
 * directly; nothing reflects back to the capture window. The finalize
 * call sends the overlay's local values.
 */
export function useToggleSync() {
  const setToggles = useOverlayStore((s) => s.setToggles);
  const setScrollDirection = useOverlayStore((s) => s.setScrollDirection);
  const setRecordFormat = useOverlayStore((s) => s.setRecordFormat);
  useEffect(() => {
    return onOverlayToggles((payload) => {
      setToggles(payload);
    });
  }, [setToggles]);
  useEffect(() => {
    return onOverlayScrollDirection((direction) => {
      setScrollDirection(direction);
    });
  }, [setScrollDirection]);
  useEffect(() => {
    return onOverlayRecordFormat((format) => {
      setRecordFormat(format);
    });
  }, [setRecordFormat]);
}
