import type { PenAnchor, Pt } from "../types";
import { useOverlayStore } from "../state/overlayStore";

/**
 * Renders the Pen / Bézier path: the curve itself (open dashed while
 * drawing, solid + filled when closed), the anchor points, their curve
 * handles, and a highlighted close-target ring on the first anchor once
 * the path can be closed. A faint rubber-band segment trails the cursor
 * from the last anchor while drawing.
 *
 * Pointer-transparent — the canvas-wide handlers own input. Self-
 * subscribes so anchor/handle edits re-render only this layer. Stroke /
 * fill use the `--color-accent` token via inline CSS (SVG presentation
 * attributes don't resolve `var()`, CSS properties do).
 */
export function PenPath() {
  const anchors = useOverlayStore((s) => s.penPath);
  const phase = useOverlayStore((s) => s.phase);
  const cursor = useOverlayStore((s) => s.cursor);
  if (anchors.length === 0) return null;

  const closed = phase === "selected";
  const canClose = !closed && anchors.length >= 3;
  const d = buildPath(anchors, closed);
  const accent = "var(--color-accent)";
  const last = anchors[anchors.length - 1]!.p;

  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
    >
      {/* Rubber-band preview from the last anchor to the cursor. */}
      {!closed && cursor && (
        <line
          x1={last.x}
          y1={last.y}
          x2={cursor.x}
          y2={cursor.y}
          style={{
            stroke: accent,
            strokeWidth: 1,
            strokeDasharray: "3 4",
            opacity: 0.5,
          }}
        />
      )}

      {/* The path. */}
      <path
        d={d}
        style={{
          stroke: accent,
          strokeWidth: 1.5,
          strokeLinejoin: "round",
          strokeLinecap: "round",
          strokeDasharray: closed ? "none" : "5 4",
          fill: closed ? accent : "none",
          fillOpacity: closed ? 0.12 : 1,
        }}
      />

      {/* Curve handles (only while editing — clutter once closed). */}
      {!closed &&
        anchors.map((a, i) => (
          <Handles key={`h${i}`} anchor={a} accent={accent} />
        ))}

      {/* Anchor points. */}
      {anchors.map((a, i) => {
        const isFirst = i === 0;
        return (
          <g key={`a${i}`}>
            {isFirst && canClose && (
              <circle
                cx={a.p.x}
                cy={a.p.y}
                r={7}
                style={{ fill: "none", stroke: accent, strokeWidth: 1.5 }}
              />
            )}
            <circle
              cx={a.p.x}
              cy={a.p.y}
              r={3}
              style={{
                fill: isFirst ? accent : "var(--color-surface)",
                stroke: accent,
                strokeWidth: 1.5,
              }}
            />
          </g>
        );
      })}
    </svg>
  );
}

function Handles({ anchor, accent }: { anchor: PenAnchor; accent: string }) {
  return (
    <>
      {anchor.hIn && <Handle from={anchor.p} to={anchor.hIn} accent={accent} />}
      {anchor.hOut && (
        <Handle from={anchor.p} to={anchor.hOut} accent={accent} />
      )}
    </>
  );
}

function Handle({ from, to, accent }: { from: Pt; to: Pt; accent: string }) {
  return (
    <g>
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        style={{ stroke: accent, strokeWidth: 1, opacity: 0.6 }}
      />
      <circle
        cx={to.x}
        cy={to.y}
        r={2.5}
        style={{ fill: accent, opacity: 0.85 }}
      />
    </g>
  );
}

/** Build the SVG `d` for a Pen path. Straight segments when neither side
 *  has a handle, cubic `C` otherwise. Adds the closing segment + `Z` when
 *  `closed`. Mirrors `flattenBezier`'s segment logic. */
function buildPath(anchors: readonly PenAnchor[], closed: boolean): string {
  const first = anchors[0];
  if (!first) return "";
  let d = `M${first.p.x},${first.p.y}`;
  const segCount = closed ? anchors.length : anchors.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = anchors[i]!;
    const b = anchors[(i + 1) % anchors.length]!;
    if (a.hOut === null && b.hIn === null) {
      d += ` L${b.p.x},${b.p.y}`;
    } else {
      const c1 = a.hOut ?? a.p;
      const c2 = b.hIn ?? b.p;
      d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.p.x},${b.p.y}`;
    }
  }
  if (closed) d += " Z";
  return d;
}
