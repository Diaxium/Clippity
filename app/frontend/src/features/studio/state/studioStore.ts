/**
 * Studio state.
 *
 * The load-bearing decision here is **who owns the playhead**. The
 * `<video>` element does. It is the thing actually decoding frames, its
 * `currentTime` is the only position that is true at any instant, and
 * a store that tried to drive it would fight it: every seek would be a
 * round trip through React, and every frame the element advanced on its
 * own would arrive as a state update the store had not asked for.
 *
 * So this store *mirrors* the element for rendering (`currentMs`, fed by
 * the player hook) and *requests* changes from it (`seek`, which bumps a
 * nonce the player hook watches). The nonce is what makes a seek to the
 * position you are already at still work — pressing Home twice, or
 * clicking the in-point handle after the playhead drifted onto it, would
 * otherwise be a no-op because the value didn't change.
 */

import { create } from "zustand";

import type { Annotation, AnnotationKind, NormRect } from "@clippity/shared";
import type { MediaInfo } from "@services/tauri/clients/media";

import {
  createAnnotation,
  moveAnnotationRange,
  resolveAnnotationDrag,
  type AnnotationEdge,
} from "../lib/annotations";
import { clampMs, stepFrame } from "../lib/time";
import {
  fullRange,
  resolveHandleDrag,
  type TrimHandle,
  type TrimRange,
} from "../lib/trim";

/**
 * A change to one annotation.
 *
 * `Partial` distributes over the union, so this is "a partial of exactly
 * one kind" rather than a bag of every kind's fields — which is what
 * stops a patch setting `radius` on a text callout.
 */
export type AnnotationPatch = Partial<Annotation>;

/** Where the clip is in its load. */
export type StudioStatus = "idle" | "loading" | "ready" | "error";

interface StudioStoreState {
  /** Capture id being shown, from the dashboard handoff. */
  id: string | null;
  info: MediaInfo | null;
  status: StudioStatus;
  /** Why the clip could not be opened. Non-null only when
   *  `status === "error"`. */
  error: string | null;

  /** Mirror of the element's position. Written by the player hook on
   *  every frame it advances; never written directly by a control. */
  currentMs: number;
  playing: boolean;
  /** `0..1`. Kept in the store rather than left to the element so it
   *  survives loading a different clip. */
  volume: number;
  muted: boolean;

  /** The in/out points. Always a valid range — see `lib/trim`. */
  range: TrimRange;
  /** Which handle a pointer is currently dragging, if any. Suppresses
   *  playback-driven playhead updates so the picture follows the handle
   *  being dragged instead of fighting it. */
  dragging: TrimHandle | null;
  /**
   * Whether the user is dragging the playhead itself.
   *
   * While they are, the store is the authority on where it is and the
   * element is *following* — so the element's own reports are stale by
   * definition and must not be written back. See {@link syncPosition}.
   */
  scrubbing: boolean;

  /** Position the player hook should seek the element to, paired with a
   *  nonce so repeating the same request still fires. */
  seekMs: number;
  seekNonce: number;

  /** Annotations over the clip, in paint order — later covers earlier. */
  annotations: Annotation[];
  /** The one being edited, if any. Drives both the handles on the
   *  picture and the highlighted bar on the timeline, so the two cannot
   *  disagree about what is selected. */
  selectedAnnotationId: string | null;

  open(id: string): void;
  loaded(info: MediaInfo): void;
  failed(message: string): void;
  /** Report where the element actually is. */
  syncPosition(ms: number): void;
  /** Ask the element to move. */
  seek(ms: number): void;
  /** Seek by whole frames from wherever the playhead currently is. */
  stepFrames(delta: number): void;
  /** Seek by a duration from wherever the playhead currently is. */
  nudge(deltaMs: number): void;
  /** Put a trim handle at the playhead. */
  setHandleToPlayhead(handle: TrimHandle): void;
  setScrubbing(scrubbing: boolean): void;
  setPlaying(playing: boolean): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setRange(range: TrimRange): void;
  setDragging(handle: TrimHandle | null): void;
  resetRange(): void;
  reset(): void;
  /** Correct the clip's length to what the element reports once it has
   *  decoded enough to know. See the action for why this is needed. */
  reconcileDuration(durationMs: number): void;

  /** Add an annotation of `kind` starting at the playhead, and select
   *  it — a new annotation the user cannot immediately adjust is a
   *  shape they have to go and find. */
  addAnnotation(kind: AnnotationKind): void;
  selectAnnotation(id: string | null): void;
  updateAnnotation(id: string, patch: AnnotationPatch): void;
  /** Move or resize an annotation's rectangle on the picture. */
  setAnnotationRect(id: string, rect: NormRect): void;
  /** Drag one end of an annotation's range, via the shared resolver. */
  dragAnnotationEdge(id: string, edge: AnnotationEdge, valueMs: number): void;
  /** Slide a whole range, keeping its length. */
  nudgeAnnotationRange(id: string, deltaMs: number): void;
  removeAnnotation(id: string): void;
  /** Replace the whole set — for loading a sidecar. */
  setAnnotations(annotations: Annotation[]): void;
}

const EMPTY = {
  info: null,
  error: null,
  currentMs: 0,
  playing: false,
  range: fullRange(0),
  dragging: null,
  scrubbing: false,
  seekMs: 0,
  // Annotations belong to the clip, so opening a different one must not
  // carry them over — they would be positioned against a picture that
  // is no longer there.
  annotations: [] as Annotation[],
  selectedAnnotationId: null,
} as const;

export const useStudioStore = create<StudioStoreState>((set, get) => ({
  id: null,
  status: "idle",
  // Full volume, unmuted: a recording's audio is usually the point of
  // reviewing it, and a player that starts silent reads as broken.
  volume: 1,
  muted: false,
  seekNonce: 0,
  ...EMPTY,

  open: (id) =>
    set((s) =>
      // Re-opening the clip already shown must not throw away the user's
      // in/out points — the dashboard re-emits its view request on every
      // cross-window jump, including ones that land back here.
      s.id === id && s.status === "ready"
        ? {}
        : { ...EMPTY, id, status: "loading", seekNonce: s.seekNonce }
    ),

  loaded: (info) =>
    set({
      info,
      status: "ready",
      error: null,
      currentMs: 0,
      range: fullRange(info.durationMs),
    }),

  failed: (message) => set({ status: "error", error: message, info: null }),

  /**
   * Report where the element actually is.
   *
   * **Ignored while the playhead is being dragged**, and that guard is
   * the fix for a real bug rather than a precaution. A drag seeks the
   * element on every pointer move, but an element seeks *asynchronously*
   * — its `seeked` and `timeupdate` events arrive after the fact,
   * carrying the position it has just finished reaching rather than the
   * one the pointer is at now.
   *
   * Written back, that stale position overwrites the fresh one and the
   * playhead jumps backwards. Dragging *towards* zero makes it
   * pathological: every late report is larger than where the pointer has
   * got to, so the playhead is repeatedly yanked forwards and simply
   * refuses to approach the start — it appears to have a floor a good
   * half-second above zero.
   *
   * While the user is dragging, the store is the authority and the
   * element is following it. The guard lives here, on the one action
   * every clock reports through, so no clock can route around it.
   */
  syncPosition: (ms) =>
    set((s) =>
      s.scrubbing ? {} : { currentMs: clampMs(ms, s.info?.durationMs ?? 0) }
    ),

  seek: (ms) =>
    set((s) => {
      const target = clampMs(ms, s.info?.durationMs ?? 0);
      return {
        // Move the mirror immediately as well as asking the element to
        // move. The element's own `seeked` event is a frame or two away,
        // and without this the playhead visibly lags the click that
        // placed it.
        currentMs: target,
        seekMs: target,
        seekNonce: s.seekNonce + 1,
      };
    }),

  // Relative moves live here, not at the call sites, and that is not
  // tidiness — it is the fix for a real bug. A component computes its
  // handler from the `currentMs` it rendered with, so three rapid clicks
  // in one tick all step from the *same* stale position and advance a
  // single frame between them. Reading the live position inside the
  // action makes every press compound, and makes the button and its
  // keyboard shortcut genuinely the same operation rather than two
  // implementations that agree until they don't.
  stepFrames: (delta) => {
    const { info, currentMs } = get();
    if (!info) return;
    get().seek(stepFrame(currentMs, info.fps, delta, info.durationMs));
  },

  nudge: (deltaMs) => {
    const { currentMs } = get();
    get().seek(currentMs + deltaMs);
  },

  setHandleToPlayhead: (handle) => {
    const { info, range, currentMs } = get();
    if (!info) return;
    // Routed through the drag resolver, so a button press can no more
    // produce an invalid range than a gesture can.
    set({
      range: resolveHandleDrag(range, handle, currentMs, info.durationMs),
    });
  },

  setScrubbing: (scrubbing) => set({ scrubbing }),

  setPlaying: (playing) => set({ playing }),

  // Dragging the slider is also the mute control: away from zero
  // unmutes, onto zero mutes. Derived from the *clamped* value, not the
  // raw one — an out-of-range drag has to agree with the volume it
  // actually produced, or the player goes silent while still showing an
  // unmuted speaker.
  setVolume: (volume) => {
    const clamped = Math.min(Math.max(volume, 0), 1);
    set({ volume: clamped, muted: clamped === 0 });
  },
  setMuted: (muted) => set({ muted }),
  setRange: (range) => set({ range }),
  setDragging: (dragging) => set({ dragging }),

  resetRange: () => set({ range: fullRange(get().info?.durationMs ?? 0) }),

  reset: () => set({ ...EMPTY, id: null, status: "idle" }),

  /**
   * Adopt the length the `<video>` element reports.
   *
   * The probe's duration comes from the container header, which is read
   * before a single frame is decoded — that is the whole reason a
   * timeline can be drawn instantly. But a header can be wrong about it.
   * The recorder writes *fragmented* MP4 so a crashed session still
   * plays (ADR 0031), and a fragmented container's header is written
   * before its length is known; a session that was paused, or cut short,
   * can leave a declared duration that no frame backs.
   *
   * The symptom is a timeline longer than the clip: the playhead reaches
   * the last real frame and stops, well short of the end of a track that
   * claims more, and every position on that track maps to the wrong
   * moment. The element is the authority here — it is the thing actually
   * decoding — so once it knows, this is what it knows.
   *
   * The in/out points are carried across rather than reset. A range that
   * spanned the whole clip re-expands to the corrected whole; anything
   * the user placed deliberately is kept and merely clamped, because
   * discarding a trim someone set because the file turned out to be
   * shorter than its header claimed would be the ruder of the two.
   */
  reconcileDuration: (durationMs) =>
    set((s) => {
      const { info, range, currentMs } = s;
      // Guard the values a media element genuinely produces before it
      // settles: `NaN` while metadata is still loading, and `Infinity`
      // for a fragmented stream whose end is not yet known.
      if (!info || !Number.isFinite(durationMs) || durationMs <= 0) return {};
      // Sub-frame disagreement is expected — the header states whole
      // milliseconds and the element works in floating-point seconds.
      if (Math.abs(durationMs - info.durationMs) < 1) return {};

      const wasFullSpan =
        range.startMs === 0 && range.endMs === info.durationMs;
      return {
        info: { ...info, durationMs },
        range: wasFullSpan
          ? fullRange(durationMs)
          : {
              startMs: Math.min(range.startMs, durationMs),
              endMs: Math.min(range.endMs, durationMs),
            },
        currentMs: clampMs(currentMs, durationMs),
      };
    }),

  // ---------- annotations ----------
  //
  // Every one of these reads the live state inside the action rather
  // than taking it as an argument, for the reason `stepFrames` above
  // gives: a component computes its handler from the values it
  // *rendered* with, so two rapid edits in one tick would both start
  // from the same stale annotation and the second would undo the first.

  addAnnotation: (kind) => {
    const { info, currentMs, annotations } = get();
    if (!info) return;
    // Starts at the playhead, because that is the moment the user is
    // looking at and therefore the one they mean.
    const annotation = createAnnotation(kind, Math.round(currentMs));
    // Clamped so an annotation added near the end of a clip does not
    // extend past it and become partly unreachable on the timeline.
    const end = Math.min(annotation.endMs, info.durationMs);
    const start = Math.min(annotation.startMs, Math.max(end - 100, 0));
    set({
      annotations: [
        ...annotations,
        { ...annotation, startMs: start, endMs: end },
      ],
      selectedAnnotationId: annotation.id,
    });
  },

  selectAnnotation: (selectedAnnotationId) => set({ selectedAnnotationId }),

  updateAnnotation: (id, patch) =>
    set((s) => ({
      annotations: s.annotations.map((annotation) =>
        annotation.id === id
          ? // The spread of a partial-of-one-kind onto that same kind is
            // sound, but not something TypeScript can follow across the
            // union — the cast asserts what the patch type already says.
            ({ ...annotation, ...patch } as Annotation)
          : annotation
      ),
    })),

  setAnnotationRect: (id, rect) => get().updateAnnotation(id, { rect }),

  dragAnnotationEdge: (id, edge, valueMs) => {
    const { info, annotations } = get();
    const annotation = annotations.find((a) => a.id === id);
    if (!info || !annotation) return;
    // Through the shared resolver, so a drag can no more produce an
    // inverted or zero-length range than a button press can.
    get().updateAnnotation(
      id,
      resolveAnnotationDrag(annotation, edge, valueMs, info.durationMs)
    );
  },

  nudgeAnnotationRange: (id, deltaMs) => {
    const { info, annotations } = get();
    const annotation = annotations.find((a) => a.id === id);
    if (!info || !annotation) return;
    get().updateAnnotation(
      id,
      moveAnnotationRange(annotation, deltaMs, info.durationMs)
    );
  },

  removeAnnotation: (id) =>
    set((s) => ({
      annotations: s.annotations.filter((a) => a.id !== id),
      // Clearing the selection matters: a selected id with nothing
      // behind it leaves the inspector rendering a panel for an
      // annotation that no longer exists.
      selectedAnnotationId:
        s.selectedAnnotationId === id ? null : s.selectedAnnotationId,
    })),

  setAnnotations: (annotations) =>
    set({ annotations, selectedAnnotationId: null }),
}));
