import { useCallback, useEffect, useRef, useState } from "react";

import type { NormRect } from "@clippity/shared";
import { coversMs, isPixelFilter } from "@clippity/shared";

import {
  hitTest,
  moveRect,
  resizeRect,
  type ResizeCorner,
} from "../lib/annotations";
import { drawAnnotations } from "../lib/drawAnnotations";
import { applyRedactions } from "../lib/redact";
import { useStudioStore } from "../state/studioStore";

/**
 * Annotations on the picture: what they look like, and how they are
 * moved.
 *
 * Two canvases, stacked, and the split is not cosmetic. The **redaction**
 * canvas has to hold a copy of the video frame, because a blur or a
 * pixelation transforms the pixels underneath and there is nothing to
 * transform unless the frame has been read. The **overlay** canvas holds
 * everything that is merely drawn, and is transparent everywhere else,
 * so the video shows through untouched.
 *
 * That stacking mirrors the export exactly: the backend applies the
 * redactions to the decoded frame and then composites the drawn overlay
 * on top of it. Same order, same operations — see `drawAnnotations` and
 * `redact.ts`.
 *
 * The overlay canvas is drawn by the *same function the export uses*,
 * which is the property the whole feature is built around. Nothing here
 * knows what an arrowhead looks like.
 */

/** Corner grab size, in device-independent pixels. */
const HANDLE_PX = 10;

/** Corners of the selection, and the rect corner each one pulls. */
const CORNERS: Array<{
  corner: ResizeCorner;
  cx: number;
  cy: number;
  cursor: string;
}> = [
  { corner: "nw", cx: 0, cy: 0, cursor: "nwse-resize" },
  { corner: "ne", cx: 1, cy: 0, cursor: "nesw-resize" },
  { corner: "sw", cx: 0, cy: 1, cursor: "nesw-resize" },
  { corner: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
];

/** What a pointer gesture on the picture is currently doing. */
type Gesture =
  | { kind: "move"; id: string; grabX: number; grabY: number; from: NormRect }
  | { kind: "resize"; id: string; corner: ResizeCorner };

interface AnnotationLayerProps {
  /** The playing element, read once per frame for the redaction preview. */
  video: HTMLVideoElement | null;
}

export function AnnotationLayer({ video }: AnnotationLayerProps) {
  const info = useStudioStore((s) => s.info);
  const currentMs = useStudioStore((s) => s.currentMs);
  const annotations = useStudioStore((s) => s.annotations);
  const selectedId = useStudioStore((s) => s.selectedAnnotationId);
  const selectAnnotation = useStudioStore((s) => s.selectAnnotation);
  const setAnnotationRect = useStudioStore((s) => s.setAnnotationRect);

  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const redactRef = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [, forceCursor] = useState(0);

  const selected = annotations.find((a) => a.id === selectedId) ?? null;
  const width = info?.width ?? 0;
  const height = info?.height ?? 0;

  /** Pointer position as a fraction of the frame. */
  const pointAt = useCallback(
    (event: React.PointerEvent): { x: number; y: number } => {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      return {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      };
    },
    []
  );

  // ---- drawing ----

  // The drawn annotations. Redrawn whenever the playhead crosses a
  // boundary or an annotation changes — cheap, because it is one clear
  // and a handful of shapes at the clip's native size.
  useEffect(() => {
    const canvas = overlayRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || width === 0) return;
    drawAnnotations(ctx, annotations, currentMs, width, height);
  }, [annotations, currentMs, width, height]);

  // The redactions. These need the frame's own pixels, so this samples
  // the `<video>` element and runs the same integer filters the export
  // runs — see `redact.ts` on why they are specified rather than
  // approximated.
  //
  // Driven by rAF rather than by the store: the picture changes sixty
  // times a second while playing and the store does not, so anything
  // keyed on state would show a redaction lagging the frame under it.
  useEffect(() => {
    const canvas = redactRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !ctx || !video || width === 0) return;

    const filters = annotations.filter(isPixelFilter);
    if (filters.length === 0) {
      ctx.clearRect(0, 0, width, height);
      return;
    }

    let raf = 0;
    const paint = () => {
      raf = requestAnimationFrame(paint);
      const ms = video.currentTime * 1_000;
      const showing = filters.filter((a) => coversMs(a, ms));
      ctx.clearRect(0, 0, width, height);
      if (showing.length === 0) return;

      // The whole frame is sampled and filtered, then masked back down
      // to the redacted rectangles below. Filtering in place needs the
      // surrounding pixels addressable at frame coordinates, and the
      // masking step is what keeps the rest of this canvas transparent.
      ctx.drawImage(video, 0, 0, width, height);
      const frame = ctx.getImageData(0, 0, width, height);
      applyRedactions(frame.data, width, height, showing, ms);
      ctx.putImageData(frame, 0, 0);

      // Everything outside a redaction must stay transparent, or this
      // canvas would hide the video it is sitting on.
      ctx.globalCompositeOperation = "destination-in";
      for (const annotation of showing) {
        const { rect } = annotation;
        ctx.fillRect(
          rect.x * width,
          rect.y * height,
          rect.w * width,
          rect.h * height
        );
      }
      ctx.globalCompositeOperation = "source-over";
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [annotations, video, width, height]);

  // ---- gestures ----

  const onPointerDown = (event: React.PointerEvent) => {
    if (!info) return;
    const point = pointAt(event);
    const hit = hitTest(annotations, point.x, point.y, currentMs);

    if (!hit) {
      // A click on empty picture clears the selection, which is how the
      // handles get out of the way of watching the clip.
      selectAnnotation(null);
      return;
    }
    event.preventDefault();
    selectAnnotation(hit.id);
    gesture.current = {
      kind: "move",
      id: hit.id,
      grabX: point.x,
      grabY: point.y,
      from: hit.rect,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* the drag proceeds without capture */
    }
  };

  const beginResize = (corner: ResizeCorner) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selected) return;
    gesture.current = { kind: "resize", id: selected.id, corner };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* the drag proceeds without capture */
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const active = gesture.current;
    if (!active) return;
    const point = pointAt(event);
    const annotation = annotations.find((a) => a.id === active.id);
    if (!annotation) return;

    if (active.kind === "move") {
      // Measured from where the rect *was* when the grab started, not
      // from its current position — accumulating deltas drifts as the
      // clamp bites at an edge.
      setAnnotationRect(
        active.id,
        moveRect(active.from, point.x - active.grabX, point.y - active.grabY)
      );
    } else {
      setAnnotationRect(
        active.id,
        resizeRect(annotation.rect, active.corner, point.x, point.y)
      );
    }
  };

  const endGesture = () => {
    gesture.current = null;
    // The cursor over a handle depends on nothing in state, so nudge a
    // render to let the hover styles settle after a drag.
    forceCursor((n) => n + 1);
  };

  if (!info) return null;

  const showHandles = selected !== null && coversMs(selected, currentMs);

  return (
    <div
      ref={hostRef}
      className="absolute inset-0"
      style={{
        // Matches the `<video>`'s object-contain box, so a fraction of
        // the frame is the same place on both.
        aspectRatio: `${width} / ${height}`,
        margin: "auto",
        maxHeight: "100%",
        maxWidth: "100%",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
    >
      <canvas
        ref={redactRef}
        width={width}
        height={height}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      <canvas
        ref={overlayRef}
        width={width}
        height={height}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />

      {showHandles ? (
        <SelectionChrome rect={selected.rect} onResize={beginResize} />
      ) : null}
    </div>
  );
}

interface SelectionChromeProps {
  rect: NormRect;
  onResize(corner: ResizeCorner): (event: React.PointerEvent) => void;
}

/**
 * The selection outline and its four corner grabs.
 *
 * DOM rather than painted onto the canvas, deliberately: the canvas is
 * the *export*, and anything drawn there would be burned into the file.
 * Chrome that exists only for editing has to live somewhere the renderer
 * cannot see it.
 */
function SelectionChrome({ rect, onResize }: SelectionChromeProps) {
  const pct = (v: number) => `${v * 100}%`;

  return (
    <>
      <div
        className="pointer-events-none absolute"
        style={{
          left: pct(rect.x),
          top: pct(rect.y),
          width: pct(rect.w),
          height: pct(rect.h),
          outline: "1px dashed var(--ed-accent)",
          outlineOffset: "1px",
        }}
      />
      {CORNERS.map(({ corner, cx, cy, cursor }) => (
        <div
          key={corner}
          role="presentation"
          onPointerDown={onResize(corner)}
          className="absolute rounded-[2px]"
          style={{
            left: pct(rect.x + rect.w * cx),
            top: pct(rect.y + rect.h * cy),
            width: HANDLE_PX,
            height: HANDLE_PX,
            transform: "translate(-50%, -50%)",
            background: "var(--ed-accent)",
            border: "1px solid var(--ed-on-accent)",
            cursor,
            touchAction: "none",
          }}
        />
      ))}
    </>
  );
}
