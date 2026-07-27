import { useEffect, useRef, useState } from "react";

import { useOverlayStore } from "../state/overlayStore";
import type { Rect, ResizeDir } from "../types";

const LOUPE_BASE = 100;
const LOUPE_MAX = 132;
const SAMPLE_RADIUS_BASE = 14;
const SAMPLE_RADIUS_PRECISION = 7;
const EDGE_PAD = 14;

interface Sample {
  x: number;
  y: number;
  px: number;
  py: number;
  rgb: [number, number, number];
}

/**
 * Precision magnifier — sub-pixel-accurate, intelligently placed,
 * resize-aware.
 *
 * Capabilities:
 *   - Smaller diameter / thinner ring than the legacy version (the
 *     loupe assists, it doesn't dominate).
 *   - Sharp pixel rendering with an optional pixel-grid overlay when
 *     the user holds Alt (precision mode).
 *   - Dynamic zoom: faster cursor velocity widens the sample window
 *     (more context); slow / precision movement narrows it (more
 *     detail). Snap events nudge the zoom up briefly.
 *   - Intelligent positioning: avoids the cursor, the active resize
 *     handle / edge, the screen boundary, and the toolbar.
 *   - Resize anchoring: during an active resize the loupe attaches to
 *     the manipulated edge so the user can see exactly what they're
 *     dragging.
 *   - Minimal reticle: faint crosshair + small accent dot. Brightens
 *     when a snap fires.
 *
 * Visibility rules:
 *   - idle / dragging: visible at the cursor (legacy parity).
 *   - active resize: visible at the active edge regardless of phase.
 *   - velocity widens the sample window (more context) instead of
 *     hiding the loupe — the legacy "hide on fast swipe" rule was
 *     surprising in practice and disappeared the loupe on routine
 *     cursor moves.
 */
export function Magnifier() {
  const phase = useOverlayStore((s) => s.phase);
  const cursor = useOverlayStore((s) => s.cursor);
  const rect = useOverlayStore((s) => s.rect);
  const dataUri = useOverlayStore((s) => s.snapshot.url);
  const sampleCtx = useOverlayStore((s) => s.snapshot.sampleCtx);
  const activeResize = useOverlayStore((s) => s.interaction.activeResize);
  const velocity = useOverlayStore((s) => s.interaction.velocity);
  const snapPulse = useOverlayStore((s) => s.interaction.snapPulse);
  const precision = useOverlayStore((s) => s.precision);

  // ── Determine the magnifier's anchor point ────────────────────────
  // During an active resize, anchor to the active edge midpoint of the
  // rect being manipulated. Otherwise follow the cursor.
  const anchor = computeAnchor(cursor, rect, activeResize);

  // Sample the pixel inline during render — sampling via useEffect +
  // setState added an extra render cycle that made the loupe visibly
  // lag the cursor by one frame. `getImageData(px, py, 1, 1)` is cheap
  // enough to do every render. Cache the last successful sample so a
  // transient out-of-bounds read doesn't blank the loupe mid-motion.
  const lastSample = useRef<Sample | null>(null);
  const visiblePhase =
    phase === "idle" || phase === "dragging" || activeResize !== null;
  let sample: Sample | null = null;
  if (visiblePhase && anchor && sampleCtx) {
    const dpr = window.devicePixelRatio || 1;
    const px = clamp(Math.floor(anchor.x * dpr), 0, sampleCtx.canvas.width - 1);
    const py = clamp(
      Math.floor(anchor.y * dpr),
      0,
      sampleCtx.canvas.height - 1
    );
    try {
      const data = sampleCtx.getImageData(px, py, 1, 1).data;
      sample = {
        x: anchor.x,
        y: anchor.y,
        px,
        py,
        rgb: [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0],
      };
      lastSample.current = sample;
    } catch {
      // Out-of-canvas read — fall back to the last good sample at the
      // current anchor so the loupe doesn't flicker out mid-drag.
      const prev = lastSample.current;
      sample = prev ? { ...prev, x: anchor.x, y: anchor.y } : null;
    }
  }

  // Replay snap-glow on every pulse fire.
  const [snapKey, setSnapKey] = useState(0);
  useEffect(() => {
    if (snapPulse > 0) setSnapKey((k) => k + 1);
  }, [snapPulse]);

  if (!sample || !dataUri) return null;

  // ── Dynamic zoom ──────────────────────────────────────────────────
  // Smaller sample radius => higher zoom (more detail). Precision mode
  // narrows further, fast motion widens the window (more context).
  const baseRadius = precision ? SAMPLE_RADIUS_PRECISION : SAMPLE_RADIUS_BASE;
  const velocityFactor = clamp(1 + velocity * 0.55, 1, 1.6);
  const snapBoost =
    snapPulse > 0 && Date.now() - snapPulse * 0 < 200 ? 0.85 : 1;
  const sampleRadius = Math.round(baseRadius * velocityFactor * snapBoost);

  const loupeSize = activeResize ? LOUPE_MAX : LOUPE_BASE;
  const scale = loupeSize / (sampleRadius * 2);

  // ── Intelligent positioning ───────────────────────────────────────
  // Pick a quadrant that minimizes overlap with the cursor / active
  // handle / screen edges / toolbar zone.
  const { left, top } = chooseQuadrant(
    sample.x,
    sample.y,
    loupeSize,
    activeResize,
    rect
  );

  const bgX = -(sample.px - sampleRadius) * scale;
  const bgY = -(sample.py - sampleRadius) * scale;
  const centerPixelSize = Math.max(3, scale);
  const showPixelGrid = precision && scale >= 6;

  return (
    <div
      aria-hidden
      className="ovl-magnifier pointer-events-none absolute z-30"
      style={{ left, top }}
    >
      <div
        className="relative overflow-hidden rounded-full"
        style={{
          border: "1.25px solid color-mix(in srgb, white 75%, transparent)",
          boxShadow:
            "0 0 0 1px rgba(0,0,0,0.32), 0 12px 28px rgba(0,0,0,0.32), 0 0 0 6px color-mix(in srgb, var(--color-accent) 0%, transparent)",
          width: loupeSize,
          height: loupeSize,
        }}
      >
        <div
          style={{
            width: loupeSize,
            height: loupeSize,
            backgroundImage: `url(${dataUri})`,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${
              sampleCtx?.canvas.width ? sampleCtx.canvas.width * scale : 0
            }px ${
              sampleCtx?.canvas.height ? sampleCtx.canvas.height * scale : 0
            }px`,
            backgroundPosition: `${bgX}px ${bgY}px`,
            imageRendering: "pixelated",
          }}
        />
        {/* Optional pixel grid for precision work (Alt + sufficiently
            zoomed). */}
        {showPixelGrid && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage: `
                linear-gradient(to right, rgba(0,0,0,0.18) 1px, transparent 1px),
                linear-gradient(to bottom, rgba(0,0,0,0.18) 1px, transparent 1px)
              `,
              backgroundSize: `${scale}px ${scale}px`,
              mixBlendMode: "difference",
            }}
          />
        )}
        {/* Minimal reticle — thin crosshair + small accent square. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-white/55 mix-blend-difference" />
          <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-white/55 mix-blend-difference" />
          <span
            key={`pix-${snapKey}`}
            className={snapKey > 0 ? "ovl-crosshair-snap" : undefined}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%,-50%)",
              width: centerPixelSize,
              height: centerPixelSize,
              border: "1px solid var(--color-accent)",
              boxShadow:
                "0 0 0 0.5px rgba(255,255,255,0.85), 0 0 5px rgba(0,0,0,0.35)",
              borderRadius: 1,
            }}
          />
          {/* Active-resize edge stripe inside the loupe — bright accent
              along the manipulated edge so the user can verify they're
              dragging the right side. */}
          {activeResize && <InsideEdgeMarker dir={activeResize} />}
          {/* Snap-glow overlay. */}
          {snapKey > 0 && (
            <span
              key={`glow-${snapKey}`}
              className="ovl-snap-pulse absolute inset-0 rounded-full"
            />
          )}
        </div>
      </div>
      <div className="mt-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-center font-mono text-[10px] font-medium text-white">
        X {sample.px} · Y {sample.py}
      </div>
      <div className="mt-1 flex items-center justify-center gap-1.5 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] font-medium text-white">
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 rounded-sm border border-white/40"
          style={{
            background: `rgb(${sample.rgb[0]}, ${sample.rgb[1]}, ${sample.rgb[2]})`,
          }}
        />
        {hexFromRgb(sample.rgb)}
      </div>
    </div>
  );
}

/**
 * Bright stripe along the active resize edge inside the magnifier.
 * Helps the user confirm which edge / corner they're dragging.
 */
function InsideEdgeMarker({ dir }: { dir: ResizeDir }) {
  const stripe = {
    position: "absolute" as const,
    background: "linear-gradient(currentColor 0 100%) var(--color-accent)",
    color: "var(--color-accent)",
    boxShadow:
      "0 0 10px 1.5px color-mix(in srgb, var(--color-accent) 65%, transparent)",
  };
  const t = 2;
  return (
    <>
      {dir.includes("n") && (
        <span
          style={{
            ...stripe,
            left: 0,
            right: 0,
            top: 0,
            height: t,
            background: "var(--color-accent)",
          }}
        />
      )}
      {dir.includes("s") && (
        <span
          style={{
            ...stripe,
            left: 0,
            right: 0,
            bottom: 0,
            height: t,
            background: "var(--color-accent)",
          }}
        />
      )}
      {dir.includes("w") && (
        <span
          style={{
            ...stripe,
            top: 0,
            bottom: 0,
            left: 0,
            width: t,
            background: "var(--color-accent)",
          }}
        />
      )}
      {dir.includes("e") && (
        <span
          style={{
            ...stripe,
            top: 0,
            bottom: 0,
            right: 0,
            width: t,
            background: "var(--color-accent)",
          }}
        />
      )}
    </>
  );
}

function computeAnchor(
  cursor: { x: number; y: number } | null,
  rect: Rect | null,
  activeResize: ResizeDir | null
): { x: number; y: number } | null {
  if (activeResize && rect) {
    // Anchor at the midpoint of the active edge (or the corner) so the
    // magnifier visually sticks to what's moving.
    const cx = activeResize.includes("w")
      ? rect.x
      : activeResize.includes("e")
        ? rect.x + rect.w
        : rect.x + rect.w / 2;
    const cy = activeResize.includes("n")
      ? rect.y
      : activeResize.includes("s")
        ? rect.y + rect.h
        : rect.y + rect.h / 2;
    return { x: cx, y: cy };
  }
  return cursor;
}

/**
 * Choose a placement quadrant that avoids the cursor, screen edges,
 * the bottom-toolbar zone, and the active resize handle.
 */
function chooseQuadrant(
  x: number,
  y: number,
  loupe: number,
  activeResize: ResizeDir | null,
  rect: Rect | null
): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const offset = activeResize ? loupe * 0.65 : 28;
  const toolbarTop = vh - 80; // reserve the bottom 80px for the toolbar

  // Candidates around the anchor — order by directional preference
  // depending on which edge is being resized.
  const candidates: Array<{ left: number; top: number; score: number }> = [];
  const dirs = [
    { dx: 1, dy: 1 },
    { dx: -1, dy: 1 },
    { dx: 1, dy: -1 },
    { dx: -1, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  for (const d of dirs) {
    const left =
      x + d.dx * offset - (d.dx < 0 ? loupe : d.dx === 0 ? loupe / 2 : 0);
    const top =
      y + d.dy * offset - (d.dy < 0 ? loupe : d.dy === 0 ? loupe / 2 : 0);
    let score = 0;
    // Penalize off-screen positions.
    if (left < EDGE_PAD) score += (EDGE_PAD - left) * 4;
    if (top < EDGE_PAD) score += (EDGE_PAD - top) * 4;
    if (left + loupe > vw - EDGE_PAD)
      score += (left + loupe - (vw - EDGE_PAD)) * 4;
    if (top + loupe > vh - EDGE_PAD)
      score += (top + loupe - (vh - EDGE_PAD)) * 4;
    // Penalize toolbar overlap.
    if (top + loupe > toolbarTop) score += (top + loupe - toolbarTop) * 2;
    // Penalize overlapping the rect's other handles when actively
    // resizing — prefer the side opposite the manipulated edge.
    if (activeResize && rect) {
      if (activeResize.includes("n") && d.dy > 0) score -= 30;
      if (activeResize.includes("s") && d.dy < 0) score -= 30;
      if (activeResize.includes("w") && d.dx > 0) score -= 30;
      if (activeResize.includes("e") && d.dx < 0) score -= 30;
    }
    candidates.push({ left, top, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0]!;
  return {
    left: clamp(best.left, EDGE_PAD, vw - loupe - EDGE_PAD),
    top: clamp(best.top, EDGE_PAD, vh - loupe - EDGE_PAD),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hexFromRgb([r, g, b]: [number, number, number]) {
  const h = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}
