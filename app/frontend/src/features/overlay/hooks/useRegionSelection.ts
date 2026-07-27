import {
  useCallback,
  useRef,
  type PointerEvent as PointerEventReact,
} from "react";

import {
  MIN_SIZE,
  applyResize,
  clampToViewport,
  pointInRect,
  rectFromPoints,
  snapSquare,
} from "../geometry";
import { syncPrecisionPointer } from "../precisionPointer";
import { useOverlayStore } from "../state/overlayStore";
import type { Pt, Rect, ResizeDir } from "../types";
import { actionPoint } from "./actionPoint";

interface PointerHandlers {
  onPointerDown(e: PointerEventReact): void;
  onPointerMove(e: PointerEventReact): void;
  onPointerUp(e: PointerEventReact): void;
}

interface SelectionDragOps {
  beginMove(rect: Rect, e: PointerEventReact): void;
  beginResize(rect: Rect, dir: ResizeDir, e: PointerEventReact): void;
  onSelectionPointerMove(e: PointerEventReact): void;
  onSelectionPointerUp(): void;
}

/**
 * Pointer-state machine for the canvas-wide Region drag + the
 * selection's own move/resize handlers.
 *
 * Side-effects beyond the basic state machine:
 *
 *   - Velocity tracking (exponential moving average) feeds the
 *     magnifier's adaptive zoom system.
 *   - `activeResize` is set/cleared on resize-handle drags so the
 *     magnifier can anchor to the manipulated edge.
 *   - `pulseSnap()` is fired when the rect snaps to a viewport edge
 *     within a small threshold — the selection border / crosshair /
 *     magnifier all react.
 */
export function useRegionSelection(): PointerHandlers & SelectionDragOps {
  const startDrag = useOverlayStore((s) => s.startDrag);
  const updateDrag = useOverlayStore((s) => s.updateDrag);
  const endDrag = useOverlayStore((s) => s.endDrag);
  const setRect = useOverlayStore((s) => s.setRect);
  const setCursor = useOverlayStore((s) => s.setCursor);
  const setCursorPin = useOverlayStore((s) => s.setCursorPin);
  const setActiveResize = useOverlayStore((s) => s.setActiveResize);
  const setVelocity = useOverlayStore((s) => s.setVelocity);
  const pulseSnap = useOverlayStore((s) => s.pulseSnap);

  // Pointer telemetry — module-level refs that survive React renders.
  const lastMove = useRef<{ at: Pt; t: number } | null>(null);
  const lastSnapAt = useRef<number>(0);

  const recordVelocity = useCallback(
    (p: Pt) => {
      const now = performance.now();
      const prev = lastMove.current;
      if (prev) {
        const dt = Math.max(1, now - prev.t);
        const dx = p.x - prev.at.x;
        const dy = p.y - prev.at.y;
        const instant = Math.hypot(dx, dy) / dt; // logical px / ms
        // Exponential smoothing — emphasises recent moves but resists
        // single-sample spikes.
        const prevV = useOverlayStore.getState().interaction.velocity;
        const smoothed = prevV * 0.6 + instant * 0.4;
        setVelocity(smoothed);
      }
      lastMove.current = { at: p, t: now };
    },
    [setVelocity]
  );

  const maybePulseSnap = useCallback(
    (next: Rect) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const tol = 1.5;
      const snapped =
        next.x <= tol ||
        next.y <= tol ||
        Math.abs(next.x + next.w - vw) <= tol ||
        Math.abs(next.y + next.h - vh) <= tol;
      if (!snapped) return;
      const now = performance.now();
      if (now - lastSnapAt.current < 220) return; // debounce
      lastSnapAt.current = now;
      pulseSnap();
    },
    [pulseSnap]
  );

  // ---------- canvas-wide drag (initial selection) ----------

  const onPointerDown = useCallback(
    (e: PointerEventReact) => {
      if (e.button !== 0) return;
      const p = actionPoint(e);
      setCursor(p);
      lastMove.current = { at: p, t: performance.now() };
      const s = useOverlayStore.getState();
      if (s.phase === "selected") {
        if (s.rect && pointInRect(p, s.rect)) return;
        setRect(null);
      }
      startDrag(p);
    },
    [setCursor, setRect, startDrag]
  );

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      const p: Pt = actionPoint(e);
      recordVelocity(p);
      if (s.phase === "dragging" && s.start) {
        // `updateDrag` already writes `cursor` (to the shift-snapped point),
        // so the unconditional `setCursor(p)` this used to do *first* was a
        // redundant store write whose value was overwritten in the same
        // handler — an extra subscriber notification (magnifier + crosshair)
        // every drag-move. Drive the cursor solely through `updateDrag` here.
        const next = e.shiftKey ? snapSquare(s.start, p) : p;
        updateDrag(next);
        maybePulseSnap(rectFromPoints(s.start, next));
      } else {
        // Not dragging: track the bare cursor. `setCursor`'s reducer also
        // lifts `empty` → `idle`, so no separate `setPhase("idle")` is needed.
        setCursor(p);
      }
      const candidate = liveOrCommittedRect();
      if (candidate && pointInRect(p, candidate)) setCursorPin(p);
    },
    [setCursor, setCursorPin, updateDrag, recordVelocity, maybePulseSnap]
  );

  const onPointerUp = useCallback(
    (_e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      if (s.phase !== "dragging") return;
      // The interaction is over — drop any precision divergence so the
      // next one starts with the reticle on the real cursor.
      syncPrecisionPointer();
      if (!s.start || !s.cur) {
        endDrag(null);
        return;
      }
      const r = rectFromPoints(s.start, s.cur);
      if (r.w < MIN_SIZE || r.h < MIN_SIZE) {
        endDrag(null);
        return;
      }
      endDrag(r);
      setCursorPin(s.cur);
    },
    [endDrag, setCursorPin]
  );

  // ---------- selection's own move/resize ----------

  const dragOp = ((): {
    current:
      | { kind: "move"; startMouse: Pt; startRect: Rect }
      | { kind: "resize"; dir: ResizeDir; startMouse: Pt; startRect: Rect }
      | null;
  } => {
    if (!sharedDragOp) sharedDragOp = { current: null };
    return sharedDragOp;
  })();

  const beginMove = useCallback(
    (rect: Rect, e: PointerEventReact) => {
      e.stopPropagation();
      e.preventDefault();
      dragOp.current = {
        kind: "move",
        // Damped point, like every move that follows — mixing a raw
        // anchor with damped moves would make the rect jump on grab.
        startMouse: actionPoint(e),
        startRect: { ...rect },
      };
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [dragOp]
  );

  const beginResize = useCallback(
    (rect: Rect, dir: ResizeDir, e: PointerEventReact) => {
      e.stopPropagation();
      e.preventDefault();
      dragOp.current = {
        kind: "resize",
        dir,
        startMouse: actionPoint(e),
        startRect: { ...rect },
      };
      setActiveResize(dir);
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    },
    [dragOp, setActiveResize]
  );

  const onSelectionPointerMove = useCallback(
    (e: PointerEventReact) => {
      const op = dragOp.current;
      if (!op) return;
      const p = actionPoint(e);
      const dx = p.x - op.startMouse.x;
      const dy = p.y - op.startMouse.y;
      setCursor(p);
      recordVelocity(p);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (op.kind === "move") {
        const next = clampToViewport(
          { ...op.startRect, x: op.startRect.x + dx, y: op.startRect.y + dy },
          vw,
          vh
        );
        setRect(next);
        maybePulseSnap(next);
        if (pointInRect(p, next)) setCursorPin(p);
      } else {
        const next = clampToViewport(
          applyResize(op.startRect, op.dir, dx, dy, e.shiftKey),
          vw,
          vh
        );
        setRect(next);
        maybePulseSnap(next);
      }
    },
    [dragOp, setCursor, setRect, setCursorPin, recordVelocity, maybePulseSnap]
  );

  const onSelectionPointerUp = useCallback(() => {
    dragOp.current = null;
    setActiveResize(null);
    syncPrecisionPointer();
  }, [dragOp, setActiveResize]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    beginMove,
    beginResize,
    onSelectionPointerMove,
    onSelectionPointerUp,
  };
}

/**
 * Whether a selection move / resize drag is currently in flight.
 *
 * Exported for the precision-pointer re-sync: releasing Alt mid-drag
 * must NOT snap the reticle back, because the rect edge would jump with
 * it. `phase === "dragging"` covers drawing a fresh rect, but a move or
 * resize of a committed rect leaves the phase at `selected` — that state
 * lives only in `sharedDragOp`, hence this accessor.
 */
export function isSelectionDragActive(): boolean {
  return sharedDragOp?.current != null;
}

let sharedDragOp: {
  current:
    | { kind: "move"; startMouse: Pt; startRect: Rect }
    | {
        kind: "resize";
        dir: ResizeDir;
        startMouse: Pt;
        startRect: Rect;
      }
    | null;
} | null = null;

function liveOrCommittedRect(): Rect | null {
  const s = useOverlayStore.getState();
  if (s.phase === "dragging" && s.start && s.cur) {
    return rectFromPoints(s.start, s.cur);
  }
  return s.rect;
}
