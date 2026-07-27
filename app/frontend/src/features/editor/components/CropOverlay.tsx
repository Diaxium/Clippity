import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { Check, RotateCcw, X } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { RESIZE_HANDLES, type ResizeHandle } from "../geometry";
import {
  CROP_ASPECTS,
  cropAspectRatio,
  sameAspect,
  type CropAspect,
} from "../lib/crop";
import {
  chromeSide,
  chromeVerticalPos,
  CHROME_MARGIN,
} from "../lib/selectionChrome";
import { useEditorStore, type Viewport } from "../state/editorStore";
import type { Rect } from "../types";

const HANDLE = 10;
/** Corner brackets read as "crop" rather than "resize an object" — they sit
 *  *inside* the frame corners, the way every crop UI draws them. */
const BRACKET = 20;
const BRACKET_W = 3;

const HANDLE_CURSOR: Record<ResizeHandle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

/**
 * The crop session's canvas chrome: everything outside the pending crop window
 * is dimmed, the window itself gets rule-of-thirds guides and drag handles, and
 * a floating bar offers aspect locks plus Reset / Cancel / Apply.
 *
 * Purely presentational, like `SelectionOverlay`: handles carry `data-crop`
 * attributes that `EditorCanvas` reads on pointer-down to start the matching
 * gesture. The bar is the only interactive part, and it stops pointer events
 * from reaching the canvas so clicking a chip never drags the crop.
 */
export function CropOverlay({ viewport }: { viewport: Viewport }) {
  const session = useEditorStore((s) => s.cropSession);
  const canvasSize = useEditorStore((s) => s.canvasSize);
  const gesture = useEditorStore((s) => s.activeGesture);

  const barRef = useRef<HTMLDivElement>(null);
  const [barBox, setBarBox] = useState({ w: 0, h: 0 });

  const rect = session?.rect ?? null;
  // Re-measure when the bar appears or disappears, not on every crop drag —
  // the rect changes continuously during a gesture but the bar's box doesn't.
  const hasRect = rect !== null;
  useLayoutEffect(() => {
    if (barRef.current) {
      const r = barRef.current.getBoundingClientRect();
      setBarBox({ w: r.width, h: r.height });
    }
  }, [hasRect]);

  if (!session || !rect) return null;

  const { zoom, panX, panY } = viewport;
  const left = rect.x * zoom + panX;
  const top = rect.y * zoom + panY;
  const width = rect.width * zoom;
  const height = rect.height * zoom;
  const dragging = gesture === "crop";

  return (
    <>
      <svg
        className="absolute inset-0 h-full w-full"
        style={{ pointerEvents: "none", overflow: "hidden" }}
        data-testid="crop-overlay"
      >
        {/* Dim everything outside the crop window (even-odd donut). */}
        <path
          d={dimPath(canvasSize, { x: left, y: top, width, height })}
          fillRule="evenodd"
          fill="var(--ed-canvas)"
          opacity={0.66}
        />
        <rect
          x={left}
          y={top}
          width={width}
          height={height}
          fill="none"
          stroke="var(--ed-selection)"
          strokeWidth={1.5}
        />
        <Thirds x={left} y={top} w={width} h={height} />

        {/* Edge bars first so the corner brackets paint over their ends. */}
        {RESIZE_HANDLES.map((h) => (
          <CropHandle
            key={h}
            handle={h}
            x={left}
            y={top}
            w={width}
            h={height}
          />
        ))}
      </svg>

      <CropBar
        ref={barRef}
        box={barBox}
        rect={rect}
        original={session.original}
        aspect={session.aspect}
        screen={{ left, top, width, height }}
        canvasSize={canvasSize}
        hidden={dragging}
      />
    </>
  );
}

/** Outer canvas rect + the crop window as a hole, for an even-odd dim fill. */
function dimPath(
  canvas: { width: number; height: number },
  r: Rect
): string {
  const outer = `M0 0H${canvas.width}V${canvas.height}H0Z`;
  const inner = `M${r.x} ${r.y}H${r.x + r.width}V${r.y + r.height}H${r.x}Z`;
  return `${outer} ${inner}`;
}

function Thirds({
  x,
  y,
  w,
  h,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  const lines = [
    [x + w / 3, y, x + w / 3, y + h],
    [x + (2 * w) / 3, y, x + (2 * w) / 3, y + h],
    [x, y + h / 3, x + w, y + h / 3],
    [x, y + (2 * h) / 3, x + w, y + (2 * h) / 3],
  ] as const;
  return (
    <>
      {lines.map(([x1, y1, x2, y2], i) => (
        <line
          key={i}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="var(--ed-selection)"
          strokeWidth={0.75}
          opacity={0.4}
        />
      ))}
    </>
  );
}

/** One drag target. Corners draw an L-bracket; edges draw a short bar. Both
 *  expose an invisible, generously sized hit rect so the grab area doesn't
 *  shrink with the visual. */
function CropHandle({
  handle,
  x,
  y,
  w,
  h,
}: {
  handle: ResizeHandle;
  x: number;
  y: number;
  w: number;
  h: number;
}) {
  const corner = handle.length === 2;
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");

  const cx = west ? x : east ? x + w : x + w / 2;
  const cy = north ? y : south ? y + h : y + h / 2;

  // Brackets/bars are inset so they hug the inside of the crop edge.
  const arm = Math.min(BRACKET, Math.max(8, Math.min(w, h) / 3));
  const shape = corner ? (
    <path
      d={
        `M${cx + (west ? 0 : -arm)} ${cy + (north ? BRACKET_W / 2 : -BRACKET_W / 2)}` +
        `H${cx + (west ? arm : 0)}` +
        `M${cx + (west ? BRACKET_W / 2 : -BRACKET_W / 2)} ${cy + (north ? 0 : -arm)}` +
        `V${cy + (north ? arm : 0)}`
      }
      stroke="var(--ed-handle-fill)"
      strokeWidth={BRACKET_W}
      fill="none"
    />
  ) : (
    <line
      x1={north || south ? cx - arm / 2 : cx}
      y1={north || south ? cy : cy - arm / 2}
      x2={north || south ? cx + arm / 2 : cx}
      y2={north || south ? cy : cy + arm / 2}
      stroke="var(--ed-handle-fill)"
      strokeWidth={BRACKET_W}
    />
  );

  const hit = corner ? BRACKET : HANDLE * 2;
  return (
    <g>
      {shape}
      <rect
        x={cx - hit / 2}
        y={cy - hit / 2}
        width={hit}
        height={hit}
        fill="transparent"
        data-crop={handle}
        aria-label={`Crop ${handle}`}
        style={{ pointerEvents: "all", cursor: HANDLE_CURSOR[handle] }}
      />
    </g>
  );
}

interface CropBarProps {
  box: { w: number; h: number };
  rect: Rect;
  original: Rect;
  aspect: number | null;
  screen: { left: number; top: number; width: number; height: number };
  canvasSize: { width: number; height: number };
  hidden: boolean;
}

/** Aspect chips + size readout + Reset/Cancel/Apply, floating beside the crop
 *  window. Placement reuses the shared selection-chrome helpers so it obeys the
 *  same above/below/pinned rules as the object toolbar and never covers the
 *  canvas's bottom rail. */
function CropBar({
  ref,
  box,
  rect,
  original,
  aspect,
  screen,
  canvasSize,
  hidden,
}: CropBarProps & { ref: Ref<HTMLDivElement> }) {
  const store = useEditorStore.getState;

  const half = box.w / 2;
  const cx = screen.left + screen.width / 2;
  const maxLeft = Math.max(
    half + CHROME_MARGIN,
    canvasSize.width - half - CHROME_MARGIN
  );
  const x = Math.min(Math.max(cx, half + CHROME_MARGIN), maxLeft);
  const side = chromeSide(
    screen.top,
    screen.top + screen.height,
    canvasSize.height,
    box.h
  );
  const { top, translateY } = chromeVerticalPos(
    side,
    screen.top,
    screen.top + screen.height,
    canvasSize.height,
    box.h
  );

  // "Original" is document-dependent, so it's derived here rather than living
  // in the static preset list.
  const aspects: CropAspect[] = [
    CROP_ASPECTS[0]!,
    { label: "Original", ratio: cropAspectRatio(original) },
    ...CROP_ASPECTS.slice(1),
  ];

  return (
    <div
      ref={ref}
      className="absolute z-30 flex items-center gap-1 rounded-[var(--radius-md)] border border-[color:var(--ed-hairline-strong)] p-1"
      style={{
        left: x,
        top,
        transform: `translate(-50%, ${translateY})`,
        background: "var(--float-bg)",
        boxShadow: "var(--shadow-medium)",
        // Kept mounted mid-drag (so it doesn't remeasure and jump on release),
        // just faded out of the way.
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? "none" : "auto",
        transition: "opacity 100ms",
      }}
      role="toolbar"
      aria-label="Crop"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {aspects.map((a) => (
        <button
          key={a.label}
          type="button"
          aria-pressed={sameAspect(aspect, a.ratio)}
          onClick={() => store().setCropAspect(a.ratio)}
          className={cn(
            "h-7 rounded-[6px] px-2 text-[11.5px] font-medium",
            sameAspect(aspect, a.ratio)
              ? "bg-[var(--ed-accent)] text-[var(--ed-on-accent)]"
              : "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
          )}
        >
          {a.label}
        </button>
      ))}

      <div className="mx-0.5 h-4 w-px bg-[var(--ed-hairline)]" />

      <span
        className="px-1 text-[11.5px] tabular-nums text-[var(--ed-text-dim)]"
        aria-label="Crop size"
      >
        {Math.round(rect.width)} × {Math.round(rect.height)}
      </span>

      <div className="mx-0.5 h-4 w-px bg-[var(--ed-hairline)]" />

      <BarButton label="Reset crop" onClick={() => store().resetCrop()}>
        <RotateCcw size={14} strokeWidth={1.75} />
      </BarButton>
      <BarButton label="Cancel crop" onClick={() => store().cancelCrop()}>
        <X size={15} strokeWidth={1.75} />
      </BarButton>
      <BarButton label="Apply crop" accent onClick={() => store().commitCrop()}>
        <Check size={15} strokeWidth={2} />
      </BarButton>
    </div>
  );
}

function BarButton({
  label,
  accent,
  onClick,
  children,
}: {
  label: string;
  accent?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-[6px]",
        accent
          ? "bg-[var(--ed-accent)] text-[var(--ed-on-accent)] hover:opacity-90"
          : "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
      )}
    >
      {children}
    </button>
  );
}
