import { useCallback, useRef } from "react";

import {
  ArrowUpRight,
  Circle,
  Droplets,
  Grid3x3,
  Square,
  Type,
} from "lucide-react";

import type { Annotation, AnnotationKind } from "@clippity/shared";
import { cn } from "@shared/lib/cn";

import { type AnnotationEdge } from "../lib/annotations";
import { fractionToMs, msToFraction } from "../lib/time";
import { useStudioStore } from "../state/studioStore";

/**
 * The annotation lane, under the trim track.
 *
 * One bar per annotation, positioned by the *same* `msToFraction` /
 * `fractionToMs` pair the trim track and the playhead use. That is not
 * incidental tidiness: a lane that did its own arithmetic would drift
 * from the playhead by a pixel, and an annotation bar that does not line
 * up with the moment it appears reads as a timeline that lies.
 *
 * Bars are stacked into rows only as far as they overlap, so a clip with
 * annotations that never coincide stays one row tall rather than growing
 * a lane per annotation.
 */

/** Height of one row of bars, in pixels. */
const ROW_PX = 18;

/** Narrowest a bar is drawn, whatever its duration.
 *
 *  A half-second annotation on a ten-minute clip is a fraction of a
 *  pixel wide, which is not a control — it is an invisible one. */
const MIN_BAR_PX = 14;

/** Icon per kind, so a bar is identifiable without reading it. */
const KIND_ICON: Record<AnnotationKind, typeof Square> = {
  box: Square,
  spotlight: Circle,
  text: Type,
  arrow: ArrowUpRight,
  pixelate: Grid3x3,
  blur: Droplets,
};

/**
 * Assign each annotation a row, packing them as tightly as their
 * overlaps allow.
 *
 * A greedy first-fit: an annotation takes the first row whose last bar
 * has already ended. Exported for its test — the failure is bars drawn
 * on top of each other, which looks like a rendering bug and is really a
 * packing one.
 */
export function packRows(annotations: readonly Annotation[]): number[] {
  /** Where the last bar in each row ends. */
  const rowEnds: number[] = [];
  return annotations.map((annotation) => {
    const row = rowEnds.findIndex((end) => end <= annotation.startMs);
    if (row === -1) {
      rowEnds.push(annotation.endMs);
      return rowEnds.length - 1;
    }
    rowEnds[row] = annotation.endMs;
    return row;
  });
}

export function AnnotationTrack() {
  const info = useStudioStore((s) => s.info);
  const annotations = useStudioStore((s) => s.annotations);
  const selectedId = useStudioStore((s) => s.selectedAnnotationId);
  const selectAnnotation = useStudioStore((s) => s.selectAnnotation);
  const dragAnnotationEdge = useStudioStore((s) => s.dragAnnotationEdge);
  const nudgeAnnotationRange = useStudioStore((s) => s.nudgeAnnotationRange);

  const trackRef = useRef<HTMLDivElement>(null);
  /** The live gesture: which annotation, and which end (or the whole bar). */
  const drag = useRef<
    | { id: string; edge: AnnotationEdge }
    | { id: string; edge: "slide"; lastMs: number }
    | null
  >(null);

  const duration = info?.durationMs ?? 0;

  const positionAt = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      return fractionToMs((clientX - rect.left) / rect.width, duration);
    },
    [duration]
  );

  if (!info || annotations.length === 0) return null;

  const pct = (ms: number) => `${msToFraction(ms, duration) * 100}%`;
  const rows = packRows(annotations);
  const rowCount = Math.max(...rows) + 1;

  const beginDrag =
    (id: string, edge: AnnotationEdge | "slide") =>
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      selectAnnotation(id);
      drag.current =
        edge === "slide"
          ? { id, edge, lastMs: positionAt(event.clientX) }
          : { id, edge };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* the drag proceeds without capture */
      }
    };

  const onPointerMove = (event: React.PointerEvent) => {
    const active = drag.current;
    if (!active) return;
    const position = positionAt(event.clientX);

    if (active.edge === "slide") {
      // Incremental, so the bar follows the pointer from wherever it was
      // grabbed rather than jumping its start under the cursor.
      nudgeAnnotationRange(active.id, position - active.lastMs);
      active.lastMs = position;
      return;
    }
    dragAnnotationEdge(active.id, active.edge, position);
  };

  const endDrag = () => {
    drag.current = null;
  };

  return (
    <div
      ref={trackRef}
      className="relative mt-1.5"
      style={{ height: rowCount * ROW_PX + (rowCount - 1) * 2 }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // The backstop: a stuck drag would leave every later gesture
      // editing the wrong annotation.
      onLostPointerCapture={endDrag}
    >
      {annotations.map((annotation, index) => {
        const Icon = KIND_ICON[annotation.kind];
        const selected = annotation.id === selectedId;
        const row = rows[index] ?? 0;

        return (
          <div
            key={annotation.id}
            role="button"
            tabIndex={0}
            aria-label={`${annotation.kind} annotation`}
            aria-pressed={selected}
            onPointerDown={beginDrag(annotation.id, "slide")}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                selectAnnotation(annotation.id);
              }
            }}
            className={cn(
              "focus-ring absolute flex cursor-grab items-center gap-1 overflow-hidden rounded-[5px] px-1 active:cursor-grabbing",
              // Grows about its own centre and lights up, so the bar
              // under the pointer is unambiguous even in a lane where
              // several sit a couple of pixels apart. `origin-center`
              // matters: a bar that grew from its left edge would appear
              // to slide, which is the one thing dragging it does.
              //
              // The transition names its properties: `left` and `width`
              // are this bar's *range*, rewritten as it is dragged, and
              // animating those would make it trail the pointer instead
              // of following it.
              "origin-center transition-[transform,filter,box-shadow] duration-150 hover:z-10 hover:scale-y-125 hover:brightness-110",
              selected
                ? "shadow-[0_0_10px_1px_var(--ed-accent)]"
                : "hover:shadow-[0_0_8px_1px_var(--ed-accent-soft)]"
            )}
            style={{
              left: pct(annotation.startMs),
              width: `${
                (msToFraction(annotation.endMs, duration) -
                  msToFraction(annotation.startMs, duration)) *
                100
              }%`,
              top: row * (ROW_PX + 2),
              height: ROW_PX,
              // A minimum width, so a very short annotation on a long
              // clip is still a target rather than a hairline that
              // cannot be hit.
              minWidth: MIN_BAR_PX,
              background: selected ? "var(--ed-accent)" : "var(--ed-elev)",
              color: selected ? "var(--ed-on-accent)" : "var(--ed-text-dim)",
              border: `1px solid ${
                selected ? "var(--ed-accent)" : "var(--ed-hairline-strong)"
              }`,
            }}
          >
            <Icon size={11} strokeWidth={2} className="shrink-0" />
            {annotation.kind === "text" ? (
              <span className="truncate text-[10px]">{annotation.text}</span>
            ) : null}

            {/* Grabs for each end. Only on the selected bar: on every bar
                they would crowd a lane of short annotations into a row of
                handles with no bar left to click. */}
            {selected ? (
              <>
                <EdgeGrab
                  side="left"
                  onPointerDown={beginDrag(annotation.id, "start")}
                />
                <EdgeGrab
                  side="right"
                  onPointerDown={beginDrag(annotation.id, "end")}
                />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface EdgeGrabProps {
  side: "left" | "right";
  onPointerDown(event: React.PointerEvent): void;
}

function EdgeGrab({ side, onPointerDown }: EdgeGrabProps) {
  return (
    <div
      role="presentation"
      onPointerDown={onPointerDown}
      className="absolute inset-y-0 w-2 cursor-ew-resize rounded-[2px] opacity-40 transition-opacity duration-150 hover:opacity-100"
      style={{
        [side]: 0,
        touchAction: "none",
        background: "var(--ed-on-accent)",
      }}
    />
  );
}
