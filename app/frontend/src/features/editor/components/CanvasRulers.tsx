import { useMemo } from "react";

import { useEditorStore } from "../state/editorStore";
import type { Viewport } from "../state/editorStore";

export const RULER_SIZE = 24;
/** Approx. screen px between labelled ticks before the step bumps up. */
const LABEL_SPACING = 92;
/** Minor ticks per major interval. */
const SUBDIVISIONS = 5;
/** Hide minor ticks once they crowd closer than this on screen. */
const MIN_MINOR_PITCH = 7;

interface CanvasRulersProps {
  viewport: Viewport;
  width: number;
  height: number;
  /** Scene-space extent of the selection, highlighted on both rulers. */
  selection: { x: number; y: number; width: number; height: number } | null;
}

interface Tick {
  pos: number;
  label: string;
}

interface Ticks {
  major: Tick[];
  minor: number[];
}

/** Round `raw` up to the nearest 1/2/5 × 10ⁿ so labels land on tidy values. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / pow;
  const mult = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return mult * pow;
}

/** Build labelled major ticks plus fainter minor ticks for one ruler axis.
 *  Indices are used (not float modulo) so a minor never lands on a major. */
function buildTicks(span: number, zoom: number, pan: number): Ticks {
  const step = niceStep(LABEL_SPACING / zoom);
  const sceneMin = (0 - pan) / zoom;
  const sceneMax = (span - pan) / zoom;

  const major: Tick[] = [];
  for (
    let m = Math.ceil(sceneMin / step);
    m <= Math.floor(sceneMax / step);
    m++
  ) {
    const v = m * step;
    major.push({ pos: v * zoom + pan, label: String(Math.round(v)) });
  }

  const minor: number[] = [];
  const minorStep = step / SUBDIVISIONS;
  if (minorStep * zoom >= MIN_MINOR_PITCH) {
    for (
      let k = Math.ceil(sceneMin / minorStep);
      k <= Math.floor(sceneMax / minorStep);
      k++
    ) {
      if (k % SUBDIVISIONS === 0) continue; // coincides with a major tick
      minor.push(k * minorStep * zoom + pan);
    }
  }
  return { major, minor };
}

/** A coordinate chip pinned to the cursor on a ruler, clamped into view. */
function CursorChip({
  axis,
  at,
  value,
  span,
}: {
  axis: "x" | "y";
  at: number;
  value: number;
  span: number;
}) {
  const label = String(Math.round(value));
  const w = label.length * 6 + 8;
  if (axis === "x") {
    const left = Math.min(Math.max(at + 4, 2), span - w - 2);
    return (
      <div
        className="absolute top-0 flex h-[14px] items-center rounded-[3px] px-1 text-[9px] font-medium tabular-nums"
        style={{
          left,
          background: "var(--ed-accent)",
          color: "var(--ed-on-accent)",
        }}
      >
        {label}
      </div>
    );
  }
  const top = Math.min(Math.max(at + 4, 2), span - 16);
  return (
    <div
      className="absolute left-0 flex items-center justify-center rounded-[3px] text-[9px] font-medium tabular-nums"
      style={{
        top,
        width: 14,
        height: w,
        background: "var(--ed-accent)",
        color: "var(--ed-on-accent)",
        writingMode: "vertical-rl",
      }}
    >
      {label}
    </div>
  );
}

/**
 * Figma-style rulers on the canvas's top and left edges. They share the canvas
 * pan/zoom origin, so a tick at scene X sits exactly above that column. Major
 * ticks are labelled and tall; minor ticks are short and faint. The selection
 * extent is shaded, and the live cursor position is marked with an accent line
 * + a coordinate chip.
 */
export function CanvasRulers({
  viewport,
  width,
  height,
  selection,
}: CanvasRulersProps) {
  const { zoom, panX, panY } = viewport;
  // Read cursor straight from the store so high-frequency cursor moves
  // re-render only the rulers, never the scene.
  const cursor = useEditorStore((s) => s.cursor);

  const horizontal = useMemo(
    () => buildTicks(width, zoom, panX),
    [width, zoom, panX]
  );
  const vertical = useMemo(
    () => buildTicks(height, zoom, panY),
    [height, zoom, panY]
  );

  const selH = selection
    ? {
        from: selection.x * zoom + panX,
        to: (selection.x + selection.width) * zoom + panX,
      }
    : null;
  const selV = selection
    ? {
        from: selection.y * zoom + panY,
        to: (selection.y + selection.height) * zoom + panY,
      }
    : null;

  const curX = cursor ? cursor.x * zoom + panX : null;
  const curY = cursor ? cursor.y * zoom + panY : null;

  return (
    <div
      className="pointer-events-none absolute inset-0 select-none"
      style={{ zIndex: 5 }}
    >
      {/* Top ruler */}
      <svg
        className="absolute left-0 top-0"
        width={width}
        height={RULER_SIZE}
        style={{ background: "var(--ed-ruler-bg)" }}
      >
        {selH && (
          <rect
            x={Math.min(selH.from, selH.to)}
            y={0}
            width={Math.abs(selH.to - selH.from)}
            height={RULER_SIZE}
            fill="var(--ed-accent-soft)"
            fillOpacity={0.5}
          />
        )}
        {horizontal.minor.map((p) => (
          <line
            key={`m${p}`}
            x1={p}
            y1={RULER_SIZE - 4}
            x2={p}
            y2={RULER_SIZE}
            stroke="var(--ed-hairline)"
          />
        ))}
        {horizontal.major.map((t) => (
          <g key={t.pos}>
            <line
              x1={t.pos}
              y1={RULER_SIZE - 8}
              x2={t.pos}
              y2={RULER_SIZE}
              stroke="var(--ed-ruler-line)"
            />
            <text
              x={t.pos + 3}
              y={9}
              fill="var(--ed-ruler-text)"
              fontSize={9}
              dominantBaseline="hanging"
            >
              {t.label}
            </text>
          </g>
        ))}
        {curX !== null && (
          <line
            x1={curX}
            y1={0}
            x2={curX}
            y2={RULER_SIZE}
            stroke="var(--ed-accent)"
            strokeWidth={1}
          />
        )}
        <line
          x1={0}
          y1={RULER_SIZE - 0.5}
          x2={width}
          y2={RULER_SIZE - 0.5}
          stroke="var(--ed-hairline)"
        />
      </svg>

      {/* Left ruler */}
      <svg
        className="absolute left-0 top-0"
        width={RULER_SIZE}
        height={height}
        style={{ background: "var(--ed-ruler-bg)" }}
      >
        {selV && (
          <rect
            x={0}
            y={Math.min(selV.from, selV.to)}
            width={RULER_SIZE}
            height={Math.abs(selV.to - selV.from)}
            fill="var(--ed-accent-soft)"
            fillOpacity={0.5}
          />
        )}
        {vertical.minor.map((p) => (
          <line
            key={`m${p}`}
            x1={RULER_SIZE - 4}
            y1={p}
            x2={RULER_SIZE}
            y2={p}
            stroke="var(--ed-hairline)"
          />
        ))}
        {vertical.major.map((t) => (
          <g key={t.pos}>
            <line
              x1={RULER_SIZE - 8}
              y1={t.pos}
              x2={RULER_SIZE}
              y2={t.pos}
              stroke="var(--ed-ruler-line)"
            />
            <text
              x={7}
              y={t.pos + 3}
              fill="var(--ed-ruler-text)"
              fontSize={9}
              transform={`rotate(-90 7 ${t.pos + 3})`}
              textAnchor="end"
            >
              {t.label}
            </text>
          </g>
        ))}
        {curY !== null && (
          <line
            x1={0}
            y1={curY}
            x2={RULER_SIZE}
            y2={curY}
            stroke="var(--ed-accent)"
            strokeWidth={1}
          />
        )}
        <line
          x1={RULER_SIZE - 0.5}
          y1={0}
          x2={RULER_SIZE - 0.5}
          y2={height}
          stroke="var(--ed-hairline)"
        />
      </svg>

      {/* Cursor coordinate chips (HTML, so the text stays crisp + clamped). */}
      {cursor && curX !== null && curX >= RULER_SIZE && (
        <CursorChip axis="x" at={curX} value={cursor.x} span={width} />
      )}
      {cursor && curY !== null && curY >= RULER_SIZE && (
        <CursorChip axis="y" at={curY} value={cursor.y} span={height} />
      )}

      {/* Corner */}
      <div
        className="absolute left-0 top-0"
        style={{
          width: RULER_SIZE,
          height: RULER_SIZE,
          background: "var(--ed-ruler-bg)",
          borderRight: "1px solid var(--ed-hairline)",
          borderBottom: "1px solid var(--ed-hairline)",
        }}
      />
    </div>
  );
}
