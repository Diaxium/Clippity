import { useOverlayStore } from "../state/overlayStore";

/**
 * Renders the in-progress / committed freehand lasso path as an SVG
 * stroke over the dimmed desktop. While drawing (`dragging`) it's an
 * open dashed polyline; once finalized (`selected`) it closes into a
 * solid polygon with a faint accent fill so the user sees exactly what
 * will be kept. Pointer-transparent — the canvas-wide handlers own
 * input. Self-subscribes so the ~120 Hz path growth re-renders only
 * this layer.
 *
 * Stroke/fill use the `--color-accent` token via inline CSS (SVG
 * presentation *attributes* don't resolve `var()`, but CSS properties
 * do).
 */
export function FreehandPath() {
  const path = useOverlayStore((s) => s.freehandPath);
  const phase = useOverlayStore((s) => s.phase);
  if (path.length === 0) return null;

  const selected = phase === "selected";
  const d =
    path.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ") +
    (selected ? " Z" : "");

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
    >
      <path
        d={d}
        style={{
          stroke: "var(--color-accent)",
          strokeWidth: 1.5,
          strokeLinejoin: "round",
          strokeLinecap: "round",
          strokeDasharray: selected ? "none" : "5 4",
          fill: selected ? "var(--color-accent)" : "none",
          fillOpacity: selected ? 0.12 : 1,
        }}
      />
    </svg>
  );
}
