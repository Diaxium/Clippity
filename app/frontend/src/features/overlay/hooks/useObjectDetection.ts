import { useCallback, useEffect, useRef } from "react";

import { detectObjects, onOverlayShown } from "@services/tauri/clients/overlay";
import { createLogger } from "@shared/lib/logger";

import { useOverlayStore } from "../state/overlayStore";

const log = createLogger("overlay");

/**
 * Owns the Object-mode detection list.
 *
 * When the overlay opens in `object` mode the backend has already
 * cached the desktop snapshot; this hook fires one `detect_objects`
 * call against it (per session — inference costs ~0.5–2 s, so never
 * per pointer event) and lands the boxes in the store for
 * `useObjectSelection` to hit-test and `ObjectHighlights` to draw.
 *
 * Keyed off the `overlay/shown` payload's mode (not the store's) so it
 * can't race `useOverlaySnapshot`'s `setMode`, and a non-object session
 * always clears stale boxes. A session counter discards a slow
 * inference result that lands after the session changed (user
 * cancelled and reopened in another mode).
 */
export function useObjectDetection() {
  const setObjects = useOverlayStore((s) => s.setObjects);
  const setObjectsStatus = useOverlayStore((s) => s.setObjectsStatus);
  const session = useRef(0);

  const detect = useCallback(async () => {
    const mySession = ++session.current;
    setObjectsStatus("detecting");
    try {
      const objects = await detectObjects();
      if (session.current !== mySession) return; // stale session
      setObjects(objects);
    } catch (err) {
      if (session.current !== mySession) return;
      log.warn("object detection failed", err);
      const message =
        err instanceof Error ? err.message : "Object detection failed.";
      setObjectsStatus("error", message);
    }
  }, [setObjects, setObjectsStatus]);

  useEffect(() => {
    return onOverlayShown((payload) => {
      if (payload.mode === "object") {
        void detect();
      } else {
        session.current++;
        setObjectsStatus("idle");
      }
    });
  }, [detect, setObjectsStatus]);
}
