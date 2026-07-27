import { useEditorStore } from "../state/editorStore";
import type { Viewport } from "../state/editorStore";

interface PenOverlayProps {
  viewport: Viewport;
}

/**
 * Live preview for an in-progress pen path: placed anchors, the committed
 * segments, and a dashed rubber-band from the last anchor to the cursor.
 * Self-subscribes to the ephemeral `pen` session so the scene doesn't re-render
 * as the cursor moves. Screen-space; pointer-transparent.
 */
export function PenOverlay({ viewport }: PenOverlayProps) {
  const pen = useEditorStore((s) => s.pen);
  if (!pen || pen.points.length === 0) return null;
  const { zoom, panX, panY } = viewport;

  const pts = pen.points.map((p) => ({
    x: p.x * zoom + panX,
    y: p.y * zoom + panY,
  }));
  const cursor = pen.cursor
    ? { x: pen.cursor.x * zoom + panX, y: pen.cursor.y * zoom + panY }
    : null;
  const last = pts[pts.length - 1]!;
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ overflow: "visible", zIndex: 18 }}
      aria-hidden
    >
      {pts.length > 1 && (
        <path
          d={d}
          fill="none"
          stroke="var(--ed-selection)"
          strokeWidth={1.5}
        />
      )}
      {cursor && (
        <line
          x1={last.x}
          y1={last.y}
          x2={cursor.x}
          y2={cursor.y}
          stroke="var(--ed-selection)"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
      )}
      {pts.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={3.5}
          fill={i === 0 ? "var(--ed-selection)" : "var(--ed-handle-fill)"}
          stroke="var(--ed-selection)"
          strokeWidth={1.5}
        />
      ))}
    </svg>
  );
}
