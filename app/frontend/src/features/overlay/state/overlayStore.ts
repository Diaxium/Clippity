/**
 * Overlay-window state.
 *
 * Feature-local Zustand slice. The legacy version (`RegionOverlay.tsx`)
 * held all of this in 20+ `useState` calls inside a 2033-line god
 * component — the rebuild keeps the state purpose-shaped and the
 * components small. Selectors are used everywhere a subscription
 * happens so pointer-move (~120 Hz) doesn't re-render every consumer.
 *
 * Cross-window concerns (theme, capture-window toggles mirror) come
 * through the `overlay/toggles` event handled by `useToggleSync`.
 */

import { create } from "zustand";

import type {
  RecorderFormat,
  RecorderRequest,
} from "@services/tauri/clients/recorder";
import type { ScrollDirection } from "@services/tauri/clients/scroll";

import { clearMask } from "../brushMask";
import { resetPrecisionPointer } from "../precisionPointer";
import type {
  BrushMode,
  DetectedObject,
  ObjectsStatus,
  OverlayMode,
  OverlayToggles,
  OverlayWindow,
  PenAnchor,
  Phase,
  Pt,
  Rect,
  ResizeDir,
} from "../types";

interface SnapshotState {
  /** URL of the cached desktop snapshot on the `clippity-snapshot`
   *  scheme — `null` until the overlay's first `useOverlaySnapshot`
   *  fetch returns. Distinct per session, so the three `url(…)`
   *  consumers share one cached decode without ever showing the
   *  previous overlay's desktop. */
  url: string | null;
  /** 2D canvas context backing the loupe's pixel sampling. `null`
   *  until the snapshot image loads. */
  sampleCtx: CanvasRenderingContext2D | null;
}

/** Per-pointer-move telemetry used by the magnifier's adaptive-zoom
 *  and snap-feedback systems. Kept off the main store fields so the
 *  fast-path subscribers (cursor) don't re-render when only velocity
 *  changes. */
interface InteractionState {
  /** Pointer velocity in logical px / ms — exponentially smoothed over
   *  the last few moves. 0 when idle, > 1 during fast swipes. */
  velocity: number;
  /** Resize handle currently under active drag, or `null`. Drives the
   *  active-edge highlight + magnifier auto-anchor systems. */
  activeResize: ResizeDir | null;
  /** Hovered resize handle (no drag in progress) — used by directional
   *  affordance hints. */
  hoverResize: ResizeDir | null;
  /** Set briefly when the selection snapped to a viewport edge / midpoint
   *  / aspect-locked corner. Cleared after ~140 ms. Drives the snap pulse
   *  / glow on crosshair + magnifier + selection border. */
  snapPulse: number;
}

interface OverlayStoreState {
  mode: OverlayMode;
  phase: Phase;
  /** Pointer-down start position in logical px. */
  start: Pt | null;
  /** Live pointer position during drag (shift-square already applied). */
  cur: Pt | null;
  /** Finalized selection rect (logical px). Set on `endDrag` with a
   *  valid (≥ MIN_SIZE) rect; null in `empty` / `idle` phases. */
  rect: Rect | null;
  /** Last pointer position the user had inside the selection rect.
   *  Sent to the backend as `cursorPin` so the screenshot cursor
   *  lands inside the crop instead of on the floating Capture button. */
  cursorPin: Pt | null;
  /** Latest pointer position in logical px. Seeded by the backend when
   *  the overlay opens so first paint can align to the real cursor. */
  cursor: Pt | null;
  /** Window-mode targets fetched from the backend when the overlay
   *  opens in `window` mode (front-to-back Z-order, physical-pixel
   *  rects). Empty in every other mode. Owned by `useOverlayWindows`. */
  windows: OverlayWindow[];
  /** `id` of the window currently under the cursor in Window mode, or
   *  null over bare desktop. Drives the highlight + the click target. */
  hoveredWindowId: number | null;
  /** Object-mode detections fetched from the backend when the overlay
   *  opens in `object` mode (canvas-local physical-pixel rects). Empty
   *  in every other mode. Owned by `useObjectDetection`. */
  objects: DetectedObject[];
  /** Index into `objects` of the detection under the cursor (smallest
   *  containing box), or null over bare desktop. */
  hoveredObjectIndex: number | null;
  /** Object-mode detection lifecycle — drives the status pill. */
  objectsStatus: ObjectsStatus;
  /** Human-readable failure when `objectsStatus === "error"`. */
  objectsError: string | null;
  /** Capture-window toggles mirror — updated by `useToggleSync` from
   *  the `clippity://overlay/toggles` event. */
  toggles: OverlayToggles;
  /** Scroll/stitch direction for Scrolling + Panoramic — seeded from the
   *  capture window via the mirror event, changeable from the overlay
   *  toolbar, sent to the backend at finalize. */
  scrollDirection: ScrollDirection;
  /** Which encoder a Record-Region / Record-Window session should feed —
   *  seeded from the capture window's Record screen via the mirror
   *  event, since the overlay is a different window and cannot see that
   *  selection. Defaults to video, the format a session started without
   *  a mirror (a preset, a future hotkey) should get. */
  recordFormat: RecorderFormat;
  /** A recording **preset's** request, mirrored across when the overlay
   *  was opened by one — everything but the rectangle, which is what the
   *  overlay is here to pick.
   *
   *  Null for an ordinary Record-Region / Record-Window session, which
   *  builds its request from live settings at finalize. Without this a
   *  region recording preset would silently ignore its own frame rate,
   *  resolution, audio and encoder settings, because the overlay is a
   *  separate window that can only see the settings store.
   *
   *  Mirrored on **every** overlay open (null when there is no preset),
   *  for the same reason the format is: a value left over from the last
   *  preset would quietly apply to the next ordinary recording. */
  recordOverride: RecorderRequest | null;
  /** `?` / F1 keybind cheat-sheet visibility. */
  helpOpen: boolean;
  /** Pre-overlay desktop snapshot for the loupe. */
  snapshot: SnapshotState;
  /** Adaptive-zoom / snap-feedback telemetry. Updated by
   *  `useRegionSelection` on every pointer move. */
  interaction: InteractionState;
  /** Precision-mode flag — modifier held for finer crosshair + pixel
   *  grid inside the magnifier. */
  precision: boolean;
  /** Flash trigger — bumped on a successful capture so the layout can
   *  fire its "freeze frame" animation. */
  captureFlash: number;
  /** Freehand-mode lasso path in logical px, in draw order. Empty
   *  unless the user is drawing / has drawn a freehand path. Reused by
   *  Magnetic-Lasso mode (same ordered-point shape; only one of the two
   *  is ever active), where each point is edge-snapped before append. */
  freehandPath: Pt[];
  /** Pen / Bézier-path anchors in draw order. Empty unless in Pen mode.
   *  Flattened to a polygon at finalize via `flattenBezier`. */
  penPath: PenAnchor[];
  /** Brush diameter in logical px. */
  brushSize: number;
  /** Whether the brush adds to or erases from the painted mask. */
  brushMode: BrushMode;
  /** Bumped on every paint so the `BrushMask` layer re-blits the
   *  offscreen mask canvas (whose pixel mutations React can't see). */
  brushVersion: number;
  /** Whether the mask currently has any painted pixels — drives the
   *  Capture-ready check. Recomputed on each stroke release. */
  brushHasInk: boolean;
  /** Multi-Area committed rects in logical px. Empty unless in
   *  multi-area mode. The in-progress rect reuses `start`/`cur` like
   *  Region; pointer-up commits it here. */
  areas: Rect[];
  /** The previous session's rectangular selection in logical px, or
   *  `null` when nothing is remembered. Fetched once per overlay mount
   *  by `useLastRegion` and shared by the `L` keybind + the toolbar's
   *  Last-region button. Deliberately NOT cleared by `reset` — it
   *  belongs to the app, not to this selection. */
  lastRegion: Rect | null;

  setMode(m: OverlayMode): void;
  setPhase(p: Phase): void;
  startDrag(at: Pt): void;
  updateDrag(at: Pt): void;
  endDrag(rect: Rect | null): void;
  setRect(r: Rect | null): void;
  setCursor(p: Pt | null): void;
  setCursorPin(p: Pt | null): void;
  setWindows(windows: OverlayWindow[]): void;
  setHoveredWindow(id: number | null): void;
  setObjects(objects: DetectedObject[]): void;
  setHoveredObject(index: number | null): void;
  setObjectsStatus(status: ObjectsStatus, error?: string | null): void;
  setToggles(partial: Partial<OverlayToggles>): void;
  setScrollDirection(d: ScrollDirection): void;
  setRecordFormat(f: RecorderFormat): void;
  setRecordOverride(r: RecorderRequest | null): void;
  setHelpOpen(b: boolean): void;
  setSnapshot(s: SnapshotState): void;
  setActiveResize(dir: ResizeDir | null): void;
  setHoverResize(dir: ResizeDir | null): void;
  setVelocity(v: number): void;
  pulseSnap(): void;
  setPrecision(p: boolean): void;
  fireCaptureFlash(): void;
  beginFreehand(at: Pt): void;
  extendFreehand(at: Pt): void;
  endFreehand(committed: boolean): void;
  addPenAnchor(anchor: PenAnchor): void;
  updatePenHandles(hIn: Pt | null, hOut: Pt | null): void;
  closePen(): void;
  popPenAnchor(): void;
  setBrushSize(size: number): void;
  setBrushMode(mode: BrushMode): void;
  /** Note a paint occurred this frame — bump the render version + keep
   *  the phase in `dragging` while the stroke is live. */
  bumpBrush(): void;
  /** Commit a finished stroke: record whether the mask has ink and move
   *  to `selected` (ready) / back to idle accordingly. */
  commitBrush(hasInk: boolean): void;
  /** Clear the painted mask (the toolbar's Clear button). */
  clearBrush(): void;
  /** Drop the current selection (rect / freehand / pen / areas) without
   *  touching the cached snapshot, cursor, or toggles — used by the
   *  Region method dropdown to switch selection tools in place. */
  clearSelection(): void;
  commitArea(rect: Rect): void;
  popArea(): void;
  setLastRegion(r: Rect | null): void;
  /** Drop the remembered rect in as a committed selection — handles on,
   *  Capture live, ready to nudge or confirm. No-op when nothing is
   *  remembered. `clamp` fits it to the current viewport. */
  restoreLastRegion(clamp: (r: Rect) => Rect): void;
  /** Reset to `empty` phase, drop selection. Called on window focus
   *  (overlay window is reused across sessions). */
  reset(initialCursor?: Pt | null): void;
}

const INITIAL_TOGGLES: OverlayToggles = {
  preview: true,
  clipboard: false,
  cursor: false,
  enhance: false,
};

const INITIAL_INTERACTION: InteractionState = {
  velocity: 0,
  activeResize: null,
  hoverResize: null,
  snapPulse: 0,
};

export const useOverlayStore = create<OverlayStoreState>((set) => ({
  mode: "region",
  phase: "empty",
  start: null,
  cur: null,
  rect: null,
  cursorPin: null,
  cursor: null,
  windows: [],
  hoveredWindowId: null,
  objects: [],
  hoveredObjectIndex: null,
  objectsStatus: "idle",
  objectsError: null,
  toggles: INITIAL_TOGGLES,
  scrollDirection: "down",
  recordFormat: "mp4",
  recordOverride: null,
  helpOpen: false,
  snapshot: { url: null, sampleCtx: null },
  interaction: INITIAL_INTERACTION,
  precision: false,
  captureFlash: 0,
  freehandPath: [],
  penPath: [],
  brushSize: 40,
  brushMode: "add",
  brushVersion: 0,
  brushHasInk: false,
  areas: [],
  lastRegion: null,

  setMode: (mode) => set({ mode }),
  setPhase: (phase) => set({ phase }),
  startDrag: (at) =>
    set({
      start: at,
      cur: at,
      cursor: at,
      rect: null,
      phase: "dragging",
    }),
  updateDrag: (at) => set({ cur: at, cursor: at }),
  endDrag: (rect) =>
    set((s) => ({
      rect,
      phase: rect ? "selected" : "idle",
      start: null,
      cur: null,
      cursor: s.cur ?? s.cursor,
    })),
  setRect: (rect) => set({ rect }),
  setCursor: (cursor) =>
    set((s) => ({
      cursor,
      phase: s.phase === "empty" && cursor ? "idle" : s.phase,
    })),
  setCursorPin: (cursorPin) => set({ cursorPin }),
  setWindows: (windows) => set({ windows }),
  setHoveredWindow: (hoveredWindowId) => set({ hoveredWindowId }),
  setObjects: (objects) =>
    set({ objects, objectsStatus: "ready", objectsError: null }),
  setHoveredObject: (hoveredObjectIndex) => set({ hoveredObjectIndex }),
  setObjectsStatus: (objectsStatus, error = null) =>
    set((s) => ({
      objectsStatus,
      objectsError: error,
      // Leaving the ready state drops stale boxes + hover.
      ...(objectsStatus !== "ready"
        ? { objects: [], hoveredObjectIndex: null }
        : { objects: s.objects }),
    })),
  setToggles: (partial) =>
    set((s) => ({ toggles: { ...s.toggles, ...partial } })),
  setScrollDirection: (scrollDirection) => set({ scrollDirection }),
  setRecordFormat: (recordFormat) => set({ recordFormat }),
  setRecordOverride: (recordOverride) => set({ recordOverride }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setActiveResize: (dir) =>
    set((s) => ({ interaction: { ...s.interaction, activeResize: dir } })),
  setHoverResize: (dir) =>
    set((s) => ({ interaction: { ...s.interaction, hoverResize: dir } })),
  setVelocity: (v) =>
    set((s) => ({ interaction: { ...s.interaction, velocity: v } })),
  pulseSnap: () =>
    set((s) => ({
      interaction: { ...s.interaction, snapPulse: s.interaction.snapPulse + 1 },
    })),
  setPrecision: (precision) => set({ precision }),
  fireCaptureFlash: () => set((s) => ({ captureFlash: s.captureFlash + 1 })),
  beginFreehand: (at) =>
    set({
      freehandPath: [at],
      phase: "dragging",
      start: at,
      cur: at,
      cursor: at,
      rect: null,
    }),
  extendFreehand: (at) =>
    set((s) => ({
      freehandPath: [...s.freehandPath, at],
      cur: at,
      cursor: at,
    })),
  endFreehand: (committed) =>
    set((s) =>
      committed
        ? { phase: "selected", start: null, cur: null }
        : {
            phase: s.cursor ? "idle" : "empty",
            freehandPath: [],
            start: null,
            cur: null,
          }
    ),
  addPenAnchor: (anchor) =>
    set((s) => ({
      penPath: [...s.penPath, anchor],
      phase: s.phase === "selected" ? s.phase : "dragging",
      cursor: anchor.p,
      cursorPin: anchor.p,
      rect: null,
    })),
  updatePenHandles: (hIn, hOut) =>
    set((s) => {
      if (s.penPath.length === 0) return {};
      const penPath = s.penPath.slice();
      const last = penPath[penPath.length - 1]!;
      penPath[penPath.length - 1] = { ...last, hIn, hOut };
      return { penPath };
    }),
  closePen: () =>
    set((s) => (s.penPath.length >= 3 ? { phase: "selected" } : {})),
  popPenAnchor: () =>
    set((s) => {
      const penPath = s.penPath.slice(0, -1);
      return {
        penPath,
        phase: penPath.length > 0 ? "dragging" : s.cursor ? "idle" : "empty",
      };
    }),
  setBrushSize: (brushSize) =>
    set({ brushSize: Math.max(2, Math.min(300, Math.round(brushSize))) }),
  setBrushMode: (brushMode) => set({ brushMode }),
  bumpBrush: () =>
    set((s) => ({
      brushVersion: s.brushVersion + 1,
      phase: s.phase === "selected" ? s.phase : "dragging",
      rect: null,
    })),
  commitBrush: (hasInk) =>
    set((s) => ({
      brushHasInk: hasInk,
      phase: hasInk ? "selected" : s.cursor ? "idle" : "empty",
    })),
  clearBrush: () => {
    clearMask();
    set((s) => ({
      brushVersion: s.brushVersion + 1,
      brushHasInk: false,
      phase: s.cursor ? "idle" : "empty",
    }));
  },
  clearSelection: () => {
    clearMask();
    set((s) => ({
      phase: s.cursor ? "idle" : "empty",
      start: null,
      cur: null,
      rect: null,
      cursorPin: null,
      freehandPath: [],
      penPath: [],
      brushHasInk: false,
      brushVersion: s.brushVersion + 1,
      areas: [],
    }));
  },
  commitArea: (rect) =>
    set((s) => ({
      areas: [...s.areas, rect],
      phase: "selected",
      start: null,
      cur: null,
    })),
  popArea: () =>
    set((s) => {
      const areas = s.areas.slice(0, -1);
      return {
        areas,
        phase: areas.length > 0 ? "selected" : s.cursor ? "idle" : "empty",
      };
    }),
  setLastRegion: (lastRegion) => set({ lastRegion }),
  restoreLastRegion: (clamp) =>
    set((s) =>
      s.lastRegion
        ? {
            rect: clamp(s.lastRegion),
            phase: "selected",
            // Any in-progress drag is abandoned — the restored rect is
            // now the selection.
            start: null,
            cur: null,
          }
        : {}
    ),
  reset: (initialCursor = null) => {
    // Drop any painted brush mask alongside the React state.
    clearMask();
    // The precision damping carries a virtual-vs-OS cursor divergence
    // across moves; a new session must start with them coincident.
    resetPrecisionPointer();
    set({
      phase: initialCursor ? "idle" : "empty",
      start: null,
      cur: null,
      rect: null,
      freehandPath: [],
      penPath: [],
      brushHasInk: false,
      areas: [],
      cursorPin: null,
      cursor: initialCursor,
      hoveredWindowId: null,
      objects: [],
      hoveredObjectIndex: null,
      objectsStatus: "idle",
      objectsError: null,
      helpOpen: false,
      snapshot: { url: null, sampleCtx: null },
      interaction: INITIAL_INTERACTION,
      precision: false,
    });
  },
}));

export type { OverlayStoreState };
