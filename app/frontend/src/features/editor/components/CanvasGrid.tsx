import { useMemo, type CSSProperties } from "react";

import type { Viewport } from "../state/editorStore";

/** Base grid pitch in scene px; doubled until dots are at least this far apart
 *  on screen, so a zoomed-out canvas never turns into a gray haze. */
const BASE_STEP = 8;
const MIN_SCREEN_PITCH = 14;

/** Pure: the dot-grid layer style for a viewport. Scene-locked — the pitch
 *  scales with zoom and the pattern is pinned to the pan origin, so dots track
 *  the content. Exported for unit testing. */
export function gridLayerStyle(viewport: Viewport): CSSProperties {
  const { zoom, panX, panY } = viewport;
  let step = BASE_STEP;
  while (step * zoom < MIN_SCREEN_PITCH) step *= 2;
  const pitch = step * zoom;
  return {
    backgroundColor: "var(--ed-canvas)",
    backgroundImage:
      "radial-gradient(circle, var(--ed-grid) 1px, transparent 1.5px)",
    backgroundSize: `${pitch}px ${pitch}px`,
    backgroundPosition: `${panX}px ${panY}px`,
    // Fade the grid out at extreme zoom-out so it stays a hint, never noise.
    opacity: zoom < 0.4 ? 0.5 : 1,
  };
}

interface CanvasGridProps {
  viewport: Viewport;
  show: boolean;
}

/**
 * A faint, scene-locked dot grid drawn behind the scene. Color is `--ed-grid`
 * (→ `--hairline`); no new palette, just depth. Toggleable from the zoom
 * controls.
 */
export function CanvasGrid({ viewport, show }: CanvasGridProps) {
  const style = useMemo(() => gridLayerStyle(viewport), [viewport]);
  if (!show) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={style}
      aria-hidden
    />
  );
}
