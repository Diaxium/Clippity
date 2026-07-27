import { useOverlayStore } from "../state/overlayStore";

/**
 * Renders the magnetic-lasso trace (stored in `freehandPath`): an open
 * dashed polyline while tracing, closing into a filled polygon once
 * `selected`. Small dots mark the snapped points and a pulsing ring sits
 * on the latest snapped point so the user sees where the edge-snap
 * landed. Pointer-transparent; self-subscribes so the trace re-renders
 * only this layer. Accent color via inline CSS (`var()` doesn't resolve
 * in SVG presentation attributes).
 */
export function MagneticLassoPath() {
  const path = useOverlayStore((s) => s.freehandPath);
  const phase = useOverlayStore((s) => s.phase);
  if (path.length === 0) return null;

  const selected = phase === "selected";
  const accent = "var(--color-accent)";
  const d =
    path.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ") +
    (selected ? " Z" : "");
  const tip = path[path.length - 1]!;

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
    >
      <path
        d={d}
        style={{
          stroke: accent,
          strokeWidth: 1.5,
          strokeLinejoin: "round",
          strokeLinecap: "round",
          strokeDasharray: selected ? "none" : "5 4",
          fill: selected ? accent : "none",
          fillOpacity: selected ? 0.12 : 1,
        }}
      />
      {/* Snapped anchor dots — light while tracing, hidden once closed to
          keep the final selection clean. */}
      {!selected &&
        path.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={1.6}
            style={{ fill: accent, opacity: 0.7 }}
          />
        ))}
      {/* Active snap indicator at the trace tip. */}
      {!selected && (
        <circle
          cx={tip.x}
          cy={tip.y}
          r={5}
          style={{ fill: "none", stroke: accent, strokeWidth: 1.5 }}
        />
      )}
    </svg>
  );
}
