import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

import { pointInRect } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";

const ARM = 18; // arm length in logical px
const GAP = 6; // gap between center and arm start
const ARM_PRECISION = 28; // arm length when precision mode (Alt) held

/**
 * Precision crosshair — thinner, CAD-style geometry with adaptive
 * contrast halo. Replaces the bulky 1px arm + heavy outer ring.
 *
 * Contextual states:
 *   - empty / idle: minimal reticle, gentle dot pulse.
 *   - dragging: arms brighten + extend slightly for precision.
 *   - hovering a resize handle: arms collapse to a directional cue
 *     pointing along the resize axis.
 *   - on snap event: brief pulse on the center dot.
 *   - precision (Alt): longer arms, brighter center dot.
 *
 * Contrast:
 *   - Arms use a thin white core (0.92α) plus a softly darkened halo
 *     via box-shadow. This keeps the crosshair readable on both
 *     bright and dark surfaces without `mix-blend-mode` artifacts.
 */
export function CrosshairCursor() {
  const phase = useOverlayStore((s) => s.phase);
  const pos = useOverlayStore((s) => s.cursor);
  const rect = useOverlayStore((s) => s.rect);
  const activeResize = useOverlayStore((s) => s.interaction.activeResize);
  const hoverResize = useOverlayStore((s) => s.interaction.hoverResize);
  const snapPulse = useOverlayStore((s) => s.interaction.snapPulse);
  const precision = useOverlayStore((s) => s.precision);

  // Replay snap pulse animation on every pulse fire.
  const [pulseKey, setPulseKey] = useState(0);
  useEffect(() => {
    if (snapPulse > 0) setPulseKey((k) => k + 1);
  }, [snapPulse]);

  // Once a selection is committed the rect is the focal point, so the
  // crosshair stays hidden *inside* it — the rect's own "move" cursor
  // takes over there. But the overlay root sets `cursor: none`, so
  // outside the rect there would be no cursor at all; show the crosshair
  // there, where a drag starts a fresh selection. Hovering a handle
  // always wins (directional affordance).
  if (!pos) return null;
  const outsideCommitted =
    phase === "selected" && (!rect || !pointInRect(pos, rect));
  const visible =
    phase === "idle" ||
    phase === "dragging" ||
    activeResize !== null ||
    hoverResize !== null ||
    outsideCommitted;
  if (!visible) return null;

  const armLen = precision ? ARM_PRECISION : ARM;
  const gap = precision ? GAP + 2 : GAP;

  // Active resize / hover collapses the perpendicular pair so the
  // crosshair becomes a directional affordance.
  const isResizing = activeResize !== null;
  const dir = activeResize ?? hoverResize;
  const showHoriz =
    !dir ||
    dir === "e" ||
    dir === "w" ||
    dir === "ne" ||
    dir === "nw" ||
    dir === "se" ||
    dir === "sw";
  const showVert =
    !dir ||
    dir === "n" ||
    dir === "s" ||
    dir === "ne" ||
    dir === "nw" ||
    dir === "se" ||
    dir === "sw";

  // Bright arm during drag / active resize; gentle during idle hover.
  const armBg =
    phase === "dragging" || isResizing
      ? "rgba(255,255,255,0.96)"
      : "rgba(255,255,255,0.86)";

  const arm: CSSProperties = {
    position: "absolute",
    background: armBg,
    boxShadow:
      "0 0 2.5px 0.5px rgba(0,0,0,0.55), 0 0 3px 1px rgba(255,255,255,0.18)",
    borderRadius: 999,
  };

  const dotPulse =
    phase === "idle" && !isResizing && !hoverResize ? "crosshair-dot" : "";
  const snapAnim = pulseKey > 0 ? "ovl-crosshair-snap" : "";

  return (
    <div
      aria-hidden
      className="ovl-crosshair-arm pointer-events-none fixed z-10"
      style={{
        left: pos.x,
        top: pos.y,
        // Smooth follow for slow movements — disabled during drag to
        // keep precision tight (the cursor IS the truth there).
        transition:
          phase === "dragging" || isResizing
            ? "none"
            : "transform 60ms cubic-bezier(0.2,0,0.05,1)",
      }}
    >
      {showHoriz && (
        <>
          <div
            style={{
              ...arm,
              left: -(gap + armLen),
              top: -0.5,
              width: armLen,
              height: 1,
            }}
          />
          <div
            style={{ ...arm, left: gap, top: -0.5, width: armLen, height: 1 }}
          />
        </>
      )}
      {showVert && (
        <>
          <div
            style={{
              ...arm,
              left: -0.5,
              top: -(gap + armLen),
              width: 1,
              height: armLen,
            }}
          />
          <div
            style={{ ...arm, left: -0.5, top: gap, width: 1, height: armLen }}
          />
        </>
      )}
      {/* Center dot — pulse in idle, snap-pulse on alignment. */}
      <div
        key={`dot-${pulseKey}`}
        className={`${dotPulse} ${snapAnim}`.trim()}
        style={{
          position: "absolute",
          left: -2,
          top: -2,
          width: 4,
          height: 4,
          borderRadius: "50%",
          background: "var(--color-accent)",
          boxShadow:
            "0 0 0 1.2px rgba(255,255,255,0.85), 0 0 5px 1.5px color-mix(in srgb, var(--color-accent) 55%, transparent)",
        }}
      />
      {/* Outer halo ring — adaptive readability layer. Faint enough to
          stay invisible on simple backgrounds but lifts the reticle off
          busy content like photos or text. */}
      <div
        style={{
          position: "absolute",
          left: -5,
          top: -5,
          width: 10,
          height: 10,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(0,0,0,0.25) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
