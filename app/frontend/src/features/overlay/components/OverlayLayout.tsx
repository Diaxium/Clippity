import {
  useEffect,
  useState,
  type PointerEvent as PointerEventReact,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauriContext } from "@services/tauri";

import { useOverlaySnapshot } from "../hooks/useOverlaySnapshot";
import { useOverlayWindows } from "../hooks/useOverlayWindows";
import {
  isSelectionDragActive,
  useRegionSelection,
} from "../hooks/useRegionSelection";
import { useWindowSelection } from "../hooks/useWindowSelection";
import { useFreehandSelection } from "../hooks/useFreehandSelection";
import { usePenSelection } from "../hooks/usePenSelection";
import { useMagneticLasso } from "../hooks/useMagneticLasso";
import { useBrushSelection } from "../hooks/useBrushSelection";
import { useMultiAreaSelection } from "../hooks/useMultiAreaSelection";
import { useColorPick } from "../hooks/useColorPick";
import { useObjectDetection } from "../hooks/useObjectDetection";
import { useObjectSelection } from "../hooks/useObjectSelection";
import { useOverlayKeybinds } from "../hooks/useOverlayKeybinds";
import { useToggleSync } from "../hooks/useToggleSync";
import { syncPrecisionPointer } from "../precisionPointer";
import { useOverlayStore } from "../state/overlayStore";

import { BottomToolbar } from "./BottomToolbar";
import { CrosshairCursor } from "./CrosshairCursor";
import { EmptyHint } from "./EmptyHint";
import { KeybindHelp } from "./KeybindHelp";
import { Magnifier } from "./Magnifier";
import { RegionSelection } from "./RegionSelection";
import { SmallSelectionPreview } from "./SmallSelectionPreview";
import { SelectionActionBar } from "./SelectionActionBar";
import { TopBanner } from "./TopBanner";
import { WindowHighlight } from "./WindowHighlight";
import { ObjectHighlights } from "./ObjectHighlights";
import { ColorPickToolbar } from "./ColorPickToolbar";
import { FreehandPath } from "./FreehandPath";
import { PenPath } from "./PenPath";
import { MagneticLassoPath } from "./MagneticLassoPath";
import { BrushMask } from "./BrushMask";
import { MultiAreaRects } from "./MultiAreaRects";

/**
 * Overlay-window root composition.
 *
 * Layers (back→front):
 *   0. Frozen desktop snapshot — the exact pixels the backend will crop
 *      at finish. Shown as soon as its data URI lands so what the user
 *      sees inside a selection is what gets captured (the live desktop
 *      behind the transparent window can drift from the cached canvas —
 *      think video, chat, a clock — and is only a fallback while the
 *      snapshot is still encoding).
 *   1. Base dim (transparent once a selection exists — the rect's huge
 *      boxShadow handles the dim).
 *   2. Outside-region dim/blur — applied while idle to make the eye
 *      drift toward the center.
 *   3. Radial vignette — barely visible, just enough to suggest focus.
 *   4. Selection (border + handles + grid) and its readout.
 *   5. Crosshair + magnifier (pointer-event-aware).
 *   6. TopBanner / BottomToolbar / SelectionActionBar (chrome).
 *   7. Keyboard cheat-sheet popover.
 *   8. Capture flash overlay — fires briefly on a successful capture.
 *
 * A11y modifiers:
 *   - `prefers-reduced-motion` mirrored to `data-motion="reduced"`.
 *   - `prefers-contrast: more` mirrored to `data-contrast="high"`.
 */
export function OverlayLayout() {
  const mode = useOverlayStore((s) => s.mode);
  const phase = useOverlayStore((s) => s.phase);
  const reset = useOverlayStore((s) => s.reset);
  const captureFlash = useOverlayStore((s) => s.captureFlash);
  const setPrecision = useOverlayStore((s) => s.setPrecision);
  const setCursor = useOverlayStore((s) => s.setCursor);
  const snapshotUri = useOverlayStore((s) => s.snapshot.url);

  const [a11y, setA11y] = useState<{
    motion: "normal" | "reduced";
    contrast: "normal" | "high";
  }>({ motion: "normal", contrast: "normal" });

  useOverlaySnapshot();
  useOverlayWindows();
  useObjectDetection();
  useToggleSync();
  useOverlayKeybinds();

  const region = useRegionSelection();
  const windowSel = useWindowSelection();
  const freehand = useFreehandSelection();
  const pen = usePenSelection();
  const magneticLasso = useMagneticLasso();
  const brush = useBrushSelection();
  const multiArea = useMultiAreaSelection();
  const colorPick = useColorPick();
  const objectSel = useObjectSelection();

  // Region keeps its selection move/resize ops (consumed by
  // RegionSelection below); each mode binds its own canvas-wide pointer
  // handlers. Window + Color-Pick are click-driven (no pointer-up).
  const {
    beginMove,
    beginResize,
    onSelectionPointerMove,
    onSelectionPointerUp,
  } = region;
  // Record-Window shares Window's entire interaction — hover highlight,
  // click to commit — and differs only in what the click starts.
  const isWindowMode = mode === "window" || mode === "record-window";
  const isObjectMode = mode === "object";
  // Click-to-pick modes that use the live OS cursor + a per-target
  // highlight instead of the crosshair + loupe: Window (whole frames)
  // and Object (AI-detected elements).
  const isPickMode = isWindowMode || isObjectMode;
  // Rect-drag modes that reuse the Region interaction + selection UI:
  // Region, Palette (crops a region), Grab-Text (OCRs a region),
  // Scrolling (records a region as the user scrolls), and Panoramic
  // (records a region as Clippity auto-scrolls it).
  // …and Record-Region (records the rect once the user commits it).
  const isRegionLike =
    mode === "region" ||
    mode === "palette" ||
    mode === "grab-text" ||
    mode === "scrolling" ||
    mode === "panoramic" ||
    mode === "record-region";
  const handlers: {
    onPointerDown?: (e: PointerEventReact) => void;
    onPointerMove?: (e: PointerEventReact) => void;
    onPointerUp?: (e: PointerEventReact) => void;
  } =
    isWindowMode
      ? {
          onPointerDown: windowSel.onPointerDown,
          onPointerMove: windowSel.onPointerMove,
        }
      : mode === "object"
        ? {
            onPointerDown: objectSel.onPointerDown,
            onPointerMove: objectSel.onPointerMove,
          }
        : mode === "freehand"
          ? freehand
          : mode === "pen"
          ? pen
          : mode === "magnetic-lasso"
          ? magneticLasso
          : mode === "brush"
          ? brush
          : mode === "multi-area"
            ? multiArea
            : mode === "color-pick"
              ? {
                  onPointerDown: colorPick.onPointerDown,
                  onPointerMove: colorPick.onPointerMove,
                }
              : {
                  onPointerDown: region.onPointerDown,
                  onPointerMove: region.onPointerMove,
                  onPointerUp: region.onPointerUp,
                };

  // The overlay window is reused — reset state every time it gains
  // focus so a new session starts at `empty` phase.
  useEffect(() => {
    // `getCurrentWindow()` throws *synchronously* in the plain-browser
    // preview / test build (no `__TAURI_INTERNALS__`), and that throw is
    // not caught by the promise `.catch()` below — left unguarded it
    // crashes the whole overlay tree into the ErrorBoundary. Skip the
    // focus-reset wiring when there's no Tauri context (matches
    // `useWindowActivity`); there's no reused OS window to reset for in a
    // browser tab anyway.
    if (!isTauriContext()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) return;
        const s = useOverlayStore.getState();
        if (s.phase === "dragging" || s.phase === "selected" || s.rect) {
          reset();
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {
        /* browser preview — no Tauri window context */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reset]);

  // Subscribe to system a11y prefs.
  useEffect(() => {
    const motionMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
    const contrastMQ = window.matchMedia("(prefers-contrast: more)");
    const sync = () =>
      setA11y({
        motion: motionMQ.matches ? "reduced" : "normal",
        contrast: contrastMQ.matches ? "high" : "normal",
      });
    sync();
    motionMQ.addEventListener("change", sync);
    contrastMQ.addEventListener("change", sync);
    return () => {
      motionMQ.removeEventListener("change", sync);
      contrastMQ.removeEventListener("change", sync);
    };
  }, []);

  // Precision modifier (Alt): pixel grid, tighter magnifier zoom, and
  // damped pointer travel (see `precisionPointer`).
  //
  // These handlers are a RESPONSIVENESS AID ONLY — they let the pixel
  // grid appear and disappear while the pointer is sitting still. They
  // are deliberately not the source of truth, because Alt key events are
  // not trustworthy here: on Windows a lone Alt press activates the
  // system menu bar and the webview never receives the keyup, so a flag
  // maintained from these alone latches on forever. `actionPoint` reads
  // the modifier off each pointer event's `altKey` instead and corrects
  // whatever this misses, on the very next move.
  useEffect(() => {
    const resync = () => {
      // A jump mid-drag would take the selection edge with it.
      if (
        useOverlayStore.getState().phase === "dragging" ||
        isSelectionDragActive()
      ) {
        return;
      }
      const at = syncPrecisionPointer();
      // Paint the correction now rather than on the next move, so it
      // reads as "let go of Alt" instead of a lurch.
      if (at) setCursor(at);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      // Swallow the keystroke so it can't reach the platform's menu-bar
      // accelerator. Nothing in the overlay wants a bare Alt, and when
      // this succeeds the matching keyup is delivered normally.
      e.preventDefault();
      setPrecision(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      e.preventDefault();
      setPrecision(false);
      resync();
    };
    // Focus loss ends the interaction outright, and is the only release
    // signal at all when the menu bar does steal the keyup.
    const blur = () => {
      setPrecision(false);
      resync();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [setPrecision, setCursor]);

  // Transparent while a region-like selection is active — the rect's
  // huge boxShadow takes over the dimming so the selected area reads
  // bright. Used by the root (over the live desktop) and by the veil
  // that re-applies the same dim over the opaque snapshot backdrop.
  const dimBackground =
    isRegionLike && (phase === "selected" || phase === "dragging")
      ? "transparent"
      : "rgba(8,12,20,0.42)";

  return (
    <div
      onPointerDown={handlers.onPointerDown}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      data-motion={a11y.motion === "reduced" ? "reduced" : undefined}
      data-contrast={a11y.contrast === "high" ? "high" : undefined}
      className={`clippity-overlay-root fixed inset-0 select-none overflow-hidden ${
        isPickMode ? "cursor-pointer" : "cursor-none"
      }`}
      style={{ background: dimBackground }}
    >
      {/* Frozen snapshot backdrop + its dim veil — see layer 0 in the
          stack doc. Stretched edge-to-edge: the snapshot covers exactly
          this window's monitor (the magnifier's sampling makes the same
          assumption), so 100%/100% is a 1:1 physical-pixel mapping. */}
      {snapshotUri && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: `url(${snapshotUri})`,
              backgroundSize: "100% 100%",
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: dimBackground }}
          />
        </>
      )}

      {/* Outside-region soft blur + desaturation — only while no
          selection has been committed (drag preview keeps it for
          continuity). Region only: Window mode needs the desktop crisp
          so the user can read the windows they're picking between. */}
      {isRegionLike && (phase === "empty" || phase === "idle") && (
        <div
          aria-hidden
          className="ovl-dim-outside pointer-events-none absolute inset-0"
        />
      )}

      {/* Subtle radial vignette */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at center, transparent 35%, rgba(0,0,0,0.18) 100%)",
        }}
      />

      {/* Rect-selection visual layers — crosshair, loupe, drag selection.
          Region / Palette / Grab-Text all crop a region; Window + Object
          use the OS cursor + a per-target highlight instead. */}
      {!isPickMode && mode !== "brush" && (
        <>
          <CrosshairCursor />
          <Magnifier />
        </>
      )}

      {isRegionLike && (
        <>
          <EmptyHint />
          <RegionSelection
            editable={phase === "selected"}
            beginMove={beginMove}
            beginResize={beginResize}
            onSelectionPointerMove={onSelectionPointerMove}
            onSelectionPointerUp={onSelectionPointerUp}
          />
          {/* Magnified content preview for a tiny selection — self-gates on a
              small rect + a loaded snapshot. Doubles as the move handle once
              committed (a tiny box's resize handles cover its whole body). */}
          <SmallSelectionPreview
            beginMove={beginMove}
            onSelectionPointerMove={onSelectionPointerMove}
            onSelectionPointerUp={onSelectionPointerUp}
          />
        </>
      )}

      {mode === "freehand" && <FreehandPath />}
      {mode === "pen" && <PenPath />}
      {mode === "magnetic-lasso" && <MagneticLassoPath />}
      {mode === "brush" && <BrushMask />}
      {mode === "multi-area" && <MultiAreaRects />}

      {/* Window-mode highlight — self-gates to `window` mode + a hover. */}
      <WindowHighlight />

      {/* Object-mode AI detections + status pill — self-gates to
          `object` mode. */}
      <ObjectHighlights />

      <TopBanner />
      {mode === "region" && <SelectionActionBar />}
      {mode === "color-pick" ? <ColorPickToolbar /> : <BottomToolbar />}
      <KeybindHelp />

      {/* Capture completion flash — key changes on every fire so React
          remounts the element and replays the animation. */}
      {captureFlash > 0 && (
        <div
          key={captureFlash}
          aria-hidden
          className="ovl-capture-flash pointer-events-none absolute inset-0 z-50"
          style={{ background: "rgba(255,255,255,0.55)" }}
        />
      )}
    </div>
  );
}
