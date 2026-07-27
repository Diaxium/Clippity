import { useEditorStore } from "../state/editorStore";
import type { Viewport } from "../state/editorStore";

interface CanvasGuidesProps {
  viewport: Viewport;
}

/**
 * Alignment guides drawn during a move/resize gesture. Self-subscribes to the
 * transient `guides` list (empty when idle) and maps each scene-space line to
 * screen space. Thin, accent-colored, slightly translucent — `--ed-selection`,
 * no new palette. Artboard-center guides read a touch stronger.
 */
export function CanvasGuides({ viewport }: CanvasGuidesProps) {
  const guides = useEditorStore((s) => s.guides);
  if (guides.length === 0) return null;
  const { zoom, panX, panY } = viewport;
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ overflow: "visible", zIndex: 6 }}
      aria-hidden
    >
      {guides.map((g, i) => {
        const opacity = g.kind === "canvas" ? 0.9 : 0.75;
        if (g.axis === "x") {
          const x = g.pos * zoom + panX;
          return (
            <line
              key={`x${i}`}
              x1={x}
              y1={g.start * zoom + panY}
              x2={x}
              y2={g.end * zoom + panY}
              stroke="var(--ed-selection)"
              strokeWidth={1}
              strokeOpacity={opacity}
              vectorEffect="non-scaling-stroke"
            />
          );
        }
        const y = g.pos * zoom + panY;
        return (
          <line
            key={`y${i}`}
            x1={g.start * zoom + panX}
            y1={y}
            x2={g.end * zoom + panX}
            y2={y}
            stroke="var(--ed-selection)"
            strokeWidth={1}
            strokeOpacity={opacity}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}
