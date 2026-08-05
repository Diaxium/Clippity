import { useCallback, useMemo, useRef } from "react";

import { formatTimecode, fractionToMs, msToFraction } from "../lib/time";
import {
  moveRange,
  rangeDurationMs,
  resolveHandleDrag,
  snapToEdges,
  type TrimHandle,
} from "../lib/trim";
import { useStudioStore } from "../state/studioStore";
import { AnnotationTrack } from "./AnnotationTrack";

/** How close a scrub has to get to an in/out point to land on it
 *  exactly, as a fraction of the visible track. Tolerance in *pixels*
 *  rather than milliseconds, because that is the unit the gesture is
 *  actually performed in — the same 40 ms is trivially hittable on a
 *  10-second clip and impossible on a 10-minute one. */
const SNAP_PX = 6;

/** Roughly how far apart the ruler's labelled ticks should sit. The
 *  interval is chosen from a ladder of round numbers so labels land on
 *  values a human reads as round — 0:05, 0:10 — rather than on whatever
 *  falls out of dividing the duration by a fixed count. */
/** How far a press has to travel before it becomes a range slide rather
 *  than a scrub. Small enough that a deliberate drag is recognised at
 *  once, large enough that the hand-tremor in a click is not. */
const SLIDE_THRESHOLD_PX = 4;

const TARGET_TICK_PX = 96;
/** Coarsest rung, and the interval for a clip longer than the ladder
 *  covers. Named rather than read back off the end of the array so the
 *  fallback is total — an hour is the widest spacing that still reads
 *  as a round number. */
const COARSEST_TICK_MS = 3_600_000;
const TICK_LADDER_MS = [
  100,
  250,
  500,
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  900_000,
  1_800_000,
  COARSEST_TICK_MS,
];

/**
 * The trim timeline: a ruler, the clip as a track, the selected range,
 * two handles and a playhead.
 *
 * One geometry rule holds the whole thing together — a position's
 * fraction of the duration is its fraction of the track's width, and
 * both rendering and pointer handling go through `msToFraction` /
 * `fractionToMs` to get it. That is what guarantees the playhead is
 * drawn exactly where a click would seek to; any component that did its
 * own arithmetic would drift out of agreement with the other by a
 * pixel, which reads as a timeline that lies.
 */
export function Timeline() {
  const info = useStudioStore((s) => s.info);
  const currentMs = useStudioStore((s) => s.currentMs);
  const range = useStudioStore((s) => s.range);
  const dragging = useStudioStore((s) => s.dragging);
  const seek = useStudioStore((s) => s.seek);
  const setRange = useStudioStore((s) => s.setRange);
  const setDragging = useStudioStore((s) => s.setDragging);
  const setScrubbing = useStudioStore((s) => s.setScrubbing);

  const trackRef = useRef<HTMLDivElement>(null);
  /**
   * The gesture in progress on the track.
   *
   * One ref rather than a handler per element, because the selected band
   * used to own its own `pointerdown` — and since the band spans the
   * whole track whenever nothing has been trimmed yet, which is how every
   * clip opens, it swallowed every click before `scrubTo` could see one.
   * Clicking the timeline did nothing at all, and the only way to place
   * the playhead was to play and pause at the right instant.
   *
   * So the track owns the gesture and the band is decoration. A press
   * scrubs; a drag scrubs continuously, unless it started on a selection
   * with somewhere to go, in which case it slides that selection.
   */
  const gesture = useRef<
    | { kind: "scrub" }
    | {
        kind: "maybeSlide";
        originX: number;
        pointerMs: number;
        startMs: number;
      }
    | { kind: "slide"; pointerMs: number; startMs: number }
    | null
  >(null);

  const duration = info?.durationMs ?? 0;

  /** Pointer x → position in the clip. */
  const positionAt = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return fractionToMs((clientX - rect.left) / rect.width, duration);
    },
    [duration]
  );

  /** The snap tolerance in milliseconds, derived from the track's
   *  current pixel width. */
  const snapToleranceMs = useCallback((): number => {
    const width = trackRef.current?.getBoundingClientRect().width ?? 0;
    return width > 0 ? (SNAP_PX / width) * duration : 0;
  }, [duration]);

  const ticks = useMemo(() => rulerTicks(duration), [duration]);

  if (!info) return null;

  const pct = (ms: number) => `${msToFraction(ms, duration) * 100}%`;

  // ---- gestures ----

  /**
   * Take pointer capture, tolerating failure.
   *
   * `setPointerCapture` throws `NotFoundError` when the pointer is no
   * longer active — a real possibility for a gesture that starts as the
   * pointer leaves the window. Capture is an *improvement* to a drag
   * (it keeps events coming when the cursor leaves the track), not a
   * precondition for one, so a failure must not be allowed to propagate
   * and abandon the gesture before it has begun.
   */
  const captureQuietly = (event: React.PointerEvent) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* drag proceeds without capture */
    }
  };

  const beginHandleDrag =
    (handle: TrimHandle) => (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // State first, capture second: the drag has to be live even if
      // capture is refused.
      setDragging(handle);
      captureQuietly(event);
    };

  const onPointerMove = (event: React.PointerEvent) => {
    // A handle drag owns the gesture outright — it was started on the
    // handle itself, which stops the event before the track sees it.
    if (dragging && gesture.current === null) {
      setRange(
        resolveHandleDrag(range, dragging, positionAt(event.clientX), duration)
      );
      return;
    }

    const active = gesture.current;
    if (!active) return;
    const position = positionAt(event.clientX);

    if (active.kind === "maybeSlide") {
      // Below the threshold this is still a click that has not let go
      // yet, so it keeps scrubbing rather than nudging the selection by
      // a pixel the user did not mean to move it.
      if (Math.abs(event.clientX - active.originX) < SLIDE_THRESHOLD_PX) {
        seek(snapToEdges(position, range, snapToleranceMs()));
        return;
      }
      gesture.current = {
        kind: "slide",
        pointerMs: active.pointerMs,
        startMs: active.startMs,
      };
      // Suppresses playback-driven playhead updates for the rest of the
      // gesture, so the picture follows the band rather than fighting it.
      setDragging("in");
      return;
    }

    if (active.kind === "slide") {
      const { pointerMs, startMs } = active;
      setRange(
        moveRange(
          { ...range, startMs, endMs: startMs + rangeDurationMs(range) },
          position - pointerMs,
          duration
        )
      );
      return;
    }

    // Continuous scrub: press and drag until the playhead is where it
    // belongs, which is the gesture that makes a frame reachable without
    // having to pause at exactly the right instant.
    seek(snapToEdges(position, range, snapToleranceMs()));
  };

  /**
   * End a drag.
   *
   * Deliberately does **not** release the pointer capture. Capture was
   * taken on the *handle*, while this handler sits on the *track* — so
   * `event.currentTarget.releasePointerCapture(...)` would be called on
   * an element that never had it and throw `NotFoundError`, skipping the
   * state reset below and leaving the timeline permanently convinced a
   * drag is in progress. The browser releases implicit capture on
   * pointerup anyway, so there is nothing to clean up here beyond our
   * own state.
   */
  const endDrag = () => {
    gesture.current = null;
    setDragging(null);
    // Hands the playhead back to the element, which resumes reporting
    // its own position — by now it has caught up with the last seek.
    setScrubbing(false);
  };

  /**
   * Press anywhere on the track: the playhead goes there.
   *
   * Snaps onto an in/out point when it lands close, since those are the
   * two positions a user most wants to hit exactly.
   *
   * The press *also* decides what a subsequent drag means. It only arms
   * a slide when the press landed inside the selection **and** that
   * selection has somewhere to go — a band that already fills the clip
   * cannot move, so treating a drag on it as a slide would spend the
   * gesture achieving nothing, when the user is far more likely to be
   * scrubbing.
   */
  /** Whether the selection has anywhere to slide to. */
  const selectionCanMove = rangeDurationMs(range) < duration;

  /**
   * Start a slide from the grab bar.
   *
   * Immediate — no movement threshold, because the press landed on a
   * control that means only one thing. The threshold exists for presses
   * on the band itself, where the same gesture could equally have meant
   * "scrub", and it does not need to apply here.
   *
   * Stops the event so the track does not also scrub: grabbing the bar
   * should move the selection, not the playhead.
   */
  const beginSlideFromGrip = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    gesture.current = {
      kind: "slide",
      pointerMs: positionAt(event.clientX),
      startMs: range.startMs,
    };
    setDragging("in");
    captureQuietly(event);
  };

  const beginGesture = (event: React.PointerEvent) => {
    if (dragging) return;
    // Claim the playhead for the whole gesture, before the first seek.
    // Every move from here seeks the element, and the element answers
    // asynchronously with where it *was* — see `syncPosition`.
    setScrubbing(true);
    const position = positionAt(event.clientX);
    seek(snapToEdges(position, range, snapToleranceMs()));

    const insideSelection =
      position >= range.startMs && position <= range.endMs;
    gesture.current =
      insideSelection && selectionCanMove
        ? {
            kind: "maybeSlide",
            originX: event.clientX,
            pointerMs: position,
            startMs: range.startMs,
          }
        : { kind: "scrub" };
    captureQuietly(event);
  };

  return (
    <div className="select-none px-6 pb-5 pt-3">
      {/* Ruler */}
      <div
        className="relative mb-1.5 h-4 text-[10px] tabular-nums"
        style={{ color: "var(--ed-text-faint)" }}
        aria-hidden="true"
      >
        {ticks.map((ms) => (
          <span
            key={ms}
            className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
            style={{ left: pct(ms) }}
          >
            {formatTimecode(ms)}
          </span>
        ))}
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        className="relative h-12 cursor-pointer rounded-[8px]"
        style={{
          background: "var(--ed-control-bg)",
          border: "1px solid var(--ed-hairline)",
        }}
        onPointerDown={beginGesture}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // The backstop. If a drag ever ends without a pointerup this
        // handler sees it — and a stuck `dragging` is not a cosmetic
        // fault: `scrubTo` refuses to seek while one is in progress, so
        // the whole timeline would go dead until the view remounted.
        onLostPointerCapture={endDrag}
      >
        {/* Tick marks, drawn on the track so the ruler's labels have
            something to point at. */}
        {ticks.map((ms) => (
          <div
            key={ms}
            aria-hidden="true"
            className="absolute top-0 h-full w-px"
            style={{ left: pct(ms), background: "var(--ed-grid)" }}
          />
        ))}

        {/* Everything outside the trim, dimmed. Two elements rather than
            one so the selected band stays the untouched, honest colour —
            dimming is what is being *added* to the excluded parts. */}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 rounded-l-[7px]"
          style={{ width: pct(range.startMs), background: "var(--ed-scrim)" }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-y-0 right-0 rounded-r-[7px]"
          style={{
            width: `${(1 - msToFraction(range.endMs, duration)) * 100}%`,
            background: "var(--ed-scrim)",
          }}
        />

        {/* The selected band. Decoration only — `pointer-events-none` is
            load-bearing: this element spans the whole track until
            something has been trimmed, so with a hit target of its own it
            intercepts every press meant for the track beneath and
            scrubbing stops working entirely. The track owns the gesture
            and decides from the *position* whether a drag slides this
            band. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0"
          style={{
            left: pct(range.startMs),
            width: `${
              (msToFraction(range.endMs, duration) -
                msToFraction(range.startMs, duration)) *
              100
            }%`,
            background: "var(--ed-accent-soft)",
            borderTop: "2px solid var(--ed-accent)",
            borderBottom: "2px solid var(--ed-accent)",
          }}
        />

        {/* The grab bar for moving the selection.

            A strip along the top of the band rather than the whole band,
            which is the compromise that lets both gestures exist: the
            band spans the entire track until something is trimmed, so
            making all of it grabbable is what broke scrubbing in the
            first place. Ten pixels of a forty-eight pixel track is an
            easy target and leaves the rest to the playhead.

            Absent when the selection fills the clip, because then it has
            nowhere to go and a control that cannot do anything is worse
            than no control. */}
        {selectionCanMove && (
          <div
            role="presentation"
            aria-label="Move selection"
            title="Drag to move the selection"
            onPointerDown={beginSlideFromGrip}
            className="group absolute top-0 z-10 flex h-[10px] cursor-grab items-center justify-center active:cursor-grabbing"
            style={{
              left: pct(range.startMs),
              width: `${
                (msToFraction(range.endMs, duration) -
                  msToFraction(range.startMs, duration)) *
                100
              }%`,
              touchAction: "none",
            }}
          >
            <div
              className="h-[3px] w-8 max-w-[70%] rounded-full transition-[width,height,box-shadow] duration-150 group-hover:h-[5px] group-hover:w-12 group-hover:shadow-[0_0_8px_2px_var(--ed-accent)]"
              style={{ background: "var(--ed-accent)" }}
            />
          </div>
        )}

        <Handle
          edge="in"
          left={pct(range.startMs)}
          onPointerDown={beginHandleDrag("in")}
        />
        <Handle
          edge="out"
          left={pct(range.endMs)}
          onPointerDown={beginHandleDrag("out")}
        />

        {/* Playhead — three siblings at one position, and the split is
            load-bearing in two ways.

            The marker has to sit *above* the trim handles so it stays
            findable while one is dragged over it, but its hit area has
            to sit *below* them: a playhead parked on a handle would
            otherwise swallow that handle's drag. So the grabbable strip
            is its own element at `z-0` and the visible parts stay at
            `z-20`, `pointer-events-none`.

            They are siblings rather than nested because `peer-hover`
            reaches siblings only — nesting the marker inside the strip
            would put it out of reach of the hover it is reacting to.

            The strip itself has no handler: a press on it bubbles to the
            track, which begins an ordinary scrub. Grabbing the playhead
            and dragging is not a special gesture, it is the gesture. */}
        <div
          aria-hidden="true"
          className="peer absolute inset-y-0 z-0 w-3.5 -translate-x-1/2 cursor-ew-resize"
          style={{ left: pct(currentMs), touchAction: "none" }}
        />
        {/* The transitions name their properties rather than using
            `transition-all`, and that is not a style preference. `left`
            here *is* the playhead's position, rewritten every frame from
            `currentMs` — animating it makes the marker chase the true
            position 150 ms behind, permanently out of step with the
            timecode beside it, and snap into place the moment playback
            stops. Only the hover response may animate. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 z-20 w-[2px] -translate-x-1/2 rounded-full transition-[width,box-shadow] duration-150 peer-hover:w-[4px] peer-hover:shadow-[0_0_8px_2px_var(--ed-text)]"
          style={{ left: pct(currentMs), background: "var(--ed-text)" }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-1 z-20 h-2 w-2 -translate-x-1/2 rotate-45 transition-[width,height,top,box-shadow] duration-150 peer-hover:-top-1.5 peer-hover:h-3 peer-hover:w-3 peer-hover:shadow-[0_0_8px_2px_var(--ed-text)]"
          style={{ left: pct(currentMs), background: "var(--ed-text)" }}
        />
      </div>

      {/* Annotations sit below the trim track and share its geometry, so
          a bar lines up with the moment its annotation appears. Renders
          nothing until there is one, keeping the timeline the height it
          has always been for anyone only trimming. */}
      <AnnotationTrack />
    </div>
  );
}

interface HandleProps {
  edge: TrimHandle;
  left: string;
  onPointerDown: (event: React.PointerEvent) => void;
}

/**
 * A trim handle.
 *
 * The hit area is deliberately wider than the visible bar: a two-pixel
 * target is a frustration, and the grab region can be generous without
 * the timeline looking heavy.
 */
function Handle({ edge, left, onPointerDown }: HandleProps) {
  const range = useStudioStore((s) => s.range);
  const duration = useStudioStore((s) => s.info?.durationMs ?? 0);
  const setRange = useStudioStore((s) => s.setRange);
  const value = edge === "in" ? range.startMs : range.endMs;

  /** Arrow keys move a focused handle, so the trim is placeable without
   *  a pointer at all. */
  const onKeyDown = (event: React.KeyboardEvent) => {
    const delta =
      event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Shift jumps a second; a bare press nudges by a frame-ish amount.
    const step = event.shiftKey ? 1_000 : 40;
    setRange(resolveHandleDrag(range, edge, value + delta * step, duration));
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={edge === "in" ? "Trim start" : "Trim end"}
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={Math.round(value)}
      aria-valuetext={formatTimecode(value)}
      className="focus-ring group absolute inset-y-0 z-10 w-4 -translate-x-1/2 cursor-ew-resize"
      style={{ left }}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    >
      {/* Both parts react to a hover anywhere in the (wider, invisible)
          hit area rather than to a hover on themselves, so the handle
          lights up as soon as it is grabbable rather than only once the
          pointer is over the three pixels that are drawn. */}
      <div
        className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-[width] duration-150 group-hover:w-[5px] group-focus:w-[5px]"
        style={{ background: "var(--ed-accent)" }}
      />
      <div
        className="absolute left-1/2 top-1/2 h-5 w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-[3px] transition-[width,height,box-shadow] duration-150 group-hover:h-7 group-hover:w-[11px] group-hover:shadow-[0_0_8px_2px_var(--ed-accent)] group-focus:h-7 group-focus:shadow-[0_0_8px_2px_var(--ed-accent)]"
        style={{
          background: "var(--ed-accent)",
          border: "1px solid var(--ed-on-accent)",
        }}
      />
    </div>
  );
}

/**
 * Positions for the ruler's labelled ticks.
 *
 * Picks the smallest interval from a ladder of round durations that
 * still leaves roughly [`TARGET_TICK_PX`] between labels, so the ruler
 * reads 0:05 / 0:10 / 0:15 rather than 0:04.37 / 0:08.74. Exported for
 * its test — the arithmetic is easy to get subtly wrong in a way that
 * only shows up on unusual clip lengths.
 */
export function rulerTicks(durationMs: number, trackPx = 900): number[] {
  if (durationMs <= 0 || trackPx <= 0) return [];
  const wanted = Math.max(Math.floor(trackPx / TARGET_TICK_PX), 1);
  const rough = durationMs / wanted;
  const interval =
    TICK_LADDER_MS.find((candidate) => candidate >= rough) ?? COARSEST_TICK_MS;

  const ticks: number[] = [];
  // Stop short of the very end: a label at 100% would render half
  // outside the track and collide with the out-point's readout.
  for (let ms = 0; ms < durationMs * 0.98; ms += interval) {
    ticks.push(ms);
  }
  return ticks;
}
