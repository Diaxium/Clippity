import { useEffect, useMemo, useRef } from "react";

import { maskCanvas } from "../brushMask";
import { useOverlayStore } from "../state/overlayStore";

/**
 * Visible Brush layer: blits the offscreen alpha mask
 * (`brushMask.ts`) onto a canvas, tinted with the accent color, plus a
 * brush-size ring that follows the cursor (the overlay hides the system
 * cursor in Brush mode). Re-blits whenever `brushVersion` bumps. The
 * canvas is sized to device pixels and stretched to the viewport so the
 * mask maps 1:1 to the snapshot underneath.
 */
export function BrushMask() {
  const version = useOverlayStore((s) => s.brushVersion);
  const cursor = useOverlayStore((s) => s.cursor);
  const brushSize = useOverlayStore((s) => s.brushSize);
  const ref = useRef<HTMLCanvasElement>(null);

  const dpr = window.devicePixelRatio || 1;
  const [dw, dh] = [
    Math.max(1, Math.round(window.innerWidth * dpr)),
    Math.max(1, Math.round(window.innerHeight * dpr)),
  ];

  // Resolve the accent token to a concrete color (canvas fillStyle can't
  // read `var(...)`). Recomputed only on mount — the theme is stable for
  // an overlay session.
  const accent = useMemo(() => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-accent")
      .trim();
    return v || "#4f8cff";
  }, []);

  useEffect(() => {
    const visible = ref.current;
    const mask = maskCanvas();
    if (!visible) return;
    const ctx = visible.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, visible.width, visible.height);
    if (!mask) return;
    ctx.drawImage(mask, 0, 0);
    // Tint the painted (alpha>0) pixels with the accent color.
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, visible.width, visible.height);
    ctx.globalCompositeOperation = "source-over";
  }, [version, accent, dw, dh]);

  return (
    <>
      <canvas
        ref={ref}
        width={dw}
        height={dh}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 h-full w-full"
        style={{ opacity: 0.42 }}
      />
      {cursor && (
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 h-full w-full"
        >
          <circle
            cx={cursor.x}
            cy={cursor.y}
            r={Math.max(2, brushSize / 2)}
            style={{
              fill: "var(--color-accent)",
              fillOpacity: 0.12,
              stroke: "var(--color-accent)",
              strokeWidth: 1.25,
            }}
          />
          <circle
            cx={cursor.x}
            cy={cursor.y}
            r={1}
            style={{ fill: "var(--color-accent)" }}
          />
        </svg>
      )}
    </>
  );
}
