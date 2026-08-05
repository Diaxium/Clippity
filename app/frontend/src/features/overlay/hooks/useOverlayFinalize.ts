import { useCallback } from "react";

import {
  finishBrushCapture,
  finishFreehandCapture,
  finishGrabText,
  finishMultiAreaCapture,
  finishPaletteCapture,
  finishRegionCapture,
} from "@services/tauri/clients/overlay";
import type { Region } from "@services/tauri/clients/overlay";

import { readMaskRLE } from "../brushMask";
import { emitErrorToast } from "@services/tauri/clients/toast";
import {
  startPanoramicCapture,
  startScrollCapture,
} from "@services/tauri/clients/scroll";
import { startRecording } from "@services/tauri/clients/recorder";
import { overlayRecorderRequest } from "@shared/lib/recorderRequest";
import { useSettingsStore } from "@features/settings";

import {
  flattenBezier,
  MIN_FREEHAND_POINTS,
  MIN_PEN_POINTS,
} from "../geometry";
import { useOverlayStore } from "../state/overlayStore";
import type { Pt, Rect } from "../types";

interface OverlayFinalize {
  /** Whether the current mode has a finalizable selection (drives the
   *  Capture button's enabled state). */
  ready: boolean;
  /** Finalize the current selection: DPR-scale, dispatch the matching
   *  backend command, fire the capture flash, reset on success, toast
   *  on failure. No-op when not `ready`. */
  finalize: () => void;
}

/** Logical-px rect → physical-px wire `Region` (DPR applied at the seam). */
function scaleRect(r: Rect, dpr: number): Region {
  return {
    x: Math.round(r.x * dpr),
    y: Math.round(r.y * dpr),
    width: Math.round(r.w * dpr),
    height: Math.round(r.h * dpr),
  };
}

function scalePin(p: Pt | null, dpr: number): [number, number] | null {
  return p ? [Math.round(p.x * dpr), Math.round(p.y * dpr)] : null;
}

/**
 * Mode-aware finalize for the drag/draw overlay modes — Region,
 * Freehand, Multi-Area, Palette (a library palette entry), Grab-Text
 * (OCR'd text), and Scrolling (starts a recording session rather than
 * producing an immediate result). Consolidates the DPR-scale +
 * dispatch + flash + reset + error-toast that previously lived duplicated
 * in `BottomToolbar.onCapture` and the `useOverlayKeybinds` Enter branch,
 * so the Capture button and the Enter key share one implementation.
 *
 * Window and Color-Pick are click-driven (finalize on pointer-down in
 * their own hooks), so they are not handled here — `ready` is false and
 * `finalize` is a no-op in those modes.
 */
export function useOverlayFinalize(): OverlayFinalize {
  const mode = useOverlayStore((s) => s.mode);
  const phase = useOverlayStore((s) => s.phase);
  const hasRect = useOverlayStore((s) => s.rect !== null);
  const pathLen = useOverlayStore((s) => s.freehandPath.length);
  const penLen = useOverlayStore((s) => s.penPath.length);
  const brushHasInk = useOverlayStore((s) => s.brushHasInk);
  const areaCount = useOverlayStore((s) => s.areas.length);

  const ready =
    mode === "region" ||
    mode === "palette" ||
    mode === "grab-text" ||
    mode === "scrolling" ||
    mode === "panoramic" ||
    mode === "record-region"
      ? phase === "selected" && hasRect
      : // Magnetic Lasso reuses the Freehand path (`freehandPath`).
        mode === "freehand" || mode === "magnetic-lasso"
        ? phase === "selected" && pathLen >= MIN_FREEHAND_POINTS
        : mode === "pen"
          ? phase === "selected" && penLen >= MIN_PEN_POINTS
          : mode === "brush"
            ? phase === "selected" && brushHasInk
            : mode === "multi-area"
              ? areaCount > 0
              : false;

  const finalize = useCallback(() => {
    const s = useOverlayStore.getState();
    const dpr = window.devicePixelRatio || 1;
    const done = () => useOverlayStore.getState().reset();
    const fail = (err: unknown) => {
      void emitErrorToast(
        err instanceof Error ? err.message : "Capture failed."
      );
    };

    if (s.mode === "region") {
      if (s.phase !== "selected" || !s.rect) return;
      s.fireCaptureFlash();
      finishRegionCapture({
        rect: scaleRect(s.rect, dpr),
        cursorPin: scalePin(s.cursorPin, dpr),
        toggles: s.toggles,
      })
        .then(done)
        .catch(fail);
      return;
    }

    // Freehand + Magnetic Lasso both finalize the `freehandPath` polygon.
    if (s.mode === "freehand" || s.mode === "magnetic-lasso") {
      if (
        s.phase !== "selected" ||
        s.freehandPath.length < MIN_FREEHAND_POINTS
      ) {
        return;
      }
      s.fireCaptureFlash();
      finishFreehandCapture({
        points: s.freehandPath.map(
          (p) =>
            [Math.round(p.x * dpr), Math.round(p.y * dpr)] as [number, number]
        ),
        cursorPin: scalePin(s.cursorPin, dpr),
        toggles: s.toggles,
      })
        .then(done)
        .catch(fail);
      return;
    }

    // Pen / Bézier — flatten the closed anchor path to a polygon, then
    // reuse the Freehand mask sink.
    if (s.mode === "pen") {
      if (s.phase !== "selected" || s.penPath.length < MIN_PEN_POINTS) return;
      const points = flattenBezier(s.penPath);
      if (points.length < MIN_PEN_POINTS) return;
      s.fireCaptureFlash();
      finishFreehandCapture({
        points: points.map(
          (p) =>
            [Math.round(p.x * dpr), Math.round(p.y * dpr)] as [number, number]
        ),
        cursorPin: scalePin(s.cursorPin, dpr),
        toggles: s.toggles,
      })
        .then(done)
        .catch(fail);
      return;
    }

    // Brush — the mask is already in device (= physical) pixels, so it
    // needs no DPR scaling; only the logical cursor pin does.
    if (s.mode === "brush") {
      const mask = readMaskRLE();
      if (!mask) return;
      s.fireCaptureFlash();
      finishBrushCapture({
        mask,
        cursorPin: scalePin(s.cursorPin, dpr),
        toggles: s.toggles,
      })
        .then(done)
        .catch(fail);
      return;
    }

    if (s.mode === "multi-area") {
      if (s.areas.length === 0) return;
      s.fireCaptureFlash();
      finishMultiAreaCapture({
        rects: s.areas.map((r) => scaleRect(r, dpr)),
        cursorPin: scalePin(s.cursorPin, dpr),
        toggles: s.toggles,
      })
        .then(done)
        .catch(fail);
    }

    if (s.mode === "palette") {
      if (s.phase !== "selected" || !s.rect) return;
      s.fireCaptureFlash();
      // Palette extraction produces a library entry + toast, not a file.
      finishPaletteCapture(scaleRect(s.rect, dpr)).then(done).catch(fail);
    }

    if (s.mode === "grab-text") {
      if (s.phase !== "selected" || !s.rect) return;
      s.fireCaptureFlash();
      // OCR produces a text library entry + toast, not a file.
      finishGrabText(scaleRect(s.rect, dpr)).then(done).catch(fail);
    }

    if (s.mode === "scrolling") {
      if (s.phase !== "selected" || !s.rect) return;
      // Starts a recording session (overlay hides, HUD takes over) —
      // not a one-shot capture. The HUD's Stop button finalizes.
      startScrollCapture(
        scaleRect(s.rect, dpr),
        s.scrollDirection,
        s.toggles.clipboard,
        s.toggles.preview
      )
        .then(done)
        .catch(fail);
    }

    if (s.mode === "panoramic") {
      if (s.phase !== "selected" || !s.rect) return;
      // Auto-scroll recording: the backend drives the scroll and the HUD
      // takes over (same session lifecycle as Scrolling, no user input).
      startPanoramicCapture(
        scaleRect(s.rect, dpr),
        s.scrollDirection,
        s.toggles.clipboard,
        s.toggles.preview
      )
        .then(done)
        .catch(fail);
    }

    if (s.mode === "record-region") {
      if (s.phase !== "selected" || !s.rect) return;
      // Starts a recorder session (ADR 0031): the backend hides the
      // overlay and raises the HUD, which owns stopping it. No capture
      // flash — nothing was captured yet, and flashing would suggest a
      // still had been taken.
      startRecording(
        overlayRecorderRequest(
          "region",
          s.recordFormat,
          useSettingsStore.getState().settings?.recording,
          s.recordOverride,
          scaleRect(s.rect, dpr)
        )
      )
        .then(done)
        .catch(fail);
    }
  }, []);

  return { ready, finalize };
}
