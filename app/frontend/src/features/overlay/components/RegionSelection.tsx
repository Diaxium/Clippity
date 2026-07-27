import type { CSSProperties, PointerEvent as PointerEventReact } from "react";
import { useEffect, useState } from "react";

import { rectFromPoints } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";
import type { Rect, ResizeDir } from "../types";
import { isTinySelection } from "./SmallSelectionPreview";

const HANDLE_SIZE = 10;
const HIT_PAD = 8; // invisible hit-zone padding around each handle
const EDGE_HANDLE_LEN = 22; // long axis of a full-size mid-edge pill
/** Below this side length (logical px) a mid-edge handle is dropped — its edge
 *  is too short to keep it clear of the two corners. */
const EDGE_HANDLE_MIN = 36;
const RESIZE_CURSORS: Record<ResizeDir, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

interface RegionSelectionProps {
  /** Whether the rect has resize/move handles (post-drag) or is just
   *  a live drag preview (no handles). */
  editable: boolean;
  beginMove(rect: Rect, e: PointerEventReact): void;
  beginResize(rect: Rect, dir: ResizeDir, e: PointerEventReact): void;
  onSelectionPointerMove(e: PointerEventReact): void;
  onSelectionPointerUp(): void;
}

/**
 * The selection rectangle — dual-layer border (crisp inner + soft glow
 * outer), fade-in rule-of-thirds grid, size badge, and 8 resize handles
 * with active-edge highlighting.
 *
 * Visual layers:
 *   - boxShadow (inset 0 100vmax): dims everything outside the rect.
 *   - boxShadow (outer): soft accent halo separating the rect from the
 *     dim surround. Stronger when editable.
 *   - border (1.5px dashed accent): the crisp inner stroke.
 *   - active-edge stripes: rendered when `activeResize` is set so the
 *     user can see exactly which edge / corner is being manipulated.
 *   - grid: rule-of-thirds, faded by default, brightens during drag /
 *     active resize for alignment work.
 */
export function RegionSelection({
  editable,
  beginMove,
  beginResize,
  onSelectionPointerMove,
  onSelectionPointerUp,
}: RegionSelectionProps) {
  const phase = useOverlayStore((s) => s.phase);
  const start = useOverlayStore((s) => s.start);
  const cur = useOverlayStore((s) => s.cur);
  const rect = useOverlayStore((s) => s.rect);
  const activeResize = useOverlayStore((s) => s.interaction.activeResize);
  const hoverResize = useOverlayStore((s) => s.interaction.hoverResize);
  const snapPulse = useOverlayStore((s) => s.interaction.snapPulse);
  const setHoverResize = useOverlayStore((s) => s.setHoverResize);
  const snapshotReady = useOverlayStore((s) => s.snapshot.url !== null);

  const renderRect: Rect | null =
    phase === "dragging" && start && cur ? rectFromPoints(start, cur) : rect;

  // Tag the rect with an `edge-settle` animation token once a rect
  // commits (phase transitions from dragging → selected).
  const [settleKey, setSettleKey] = useState<number>(0);
  useEffect(() => {
    if (phase === "selected") setSettleKey((k) => k + 1);
  }, [phase]);

  if (!renderRect) return null;

  const dpr = window.devicePixelRatio || 1;
  const handles: { dir: ResizeDir; left: number; top: number }[] = [
    { dir: "nw", left: 0, top: 0 },
    { dir: "n", left: renderRect.w / 2, top: 0 },
    { dir: "ne", left: renderRect.w, top: 0 },
    { dir: "e", left: renderRect.w, top: renderRect.h / 2 },
    { dir: "se", left: renderRect.w, top: renderRect.h },
    { dir: "s", left: renderRect.w / 2, top: renderRect.h },
    { dir: "sw", left: 0, top: renderRect.h },
    { dir: "w", left: 0, top: renderRect.h / 2 },
  ];

  // Shrink the resize handles — and shed the mid-edge ones — as the box gets
  // small, so the eight of them stop piling on top of each other. The four
  // corners always stay (the primary resize grip); a mid-edge handle drops once
  // its edge is too short to seat it clear of the two corners. Scaling keys off
  // the *smaller* side, so a short-but-wide box scales by whichever dimension is
  // actually cramped. Handles only render while editable (committed), so this
  // never affects the live drag-out.
  const minDim = Math.min(renderRect.w, renderRect.h);
  const handleScale = Math.max(0.65, Math.min(1, minDim / 48));
  const cornerSize = Math.round(HANDLE_SIZE * handleScale);
  const edgeLong = Math.round(EDGE_HANDLE_LEN * handleScale);
  const edgeThick = Math.round((HANDLE_SIZE - 2) * handleScale);
  const showTopBottomEdges = renderRect.w >= EDGE_HANDLE_MIN; // n, s
  const showLeftRightEdges = renderRect.h >= EDGE_HANDLE_MIN; // e, w
  const sizedHandles = handles.filter((h) =>
    h.dir === "n" || h.dir === "s"
      ? showTopBottomEdges
      : h.dir === "e" || h.dir === "w"
        ? showLeftRightEdges
        : true
  );

  // Grid is visible during drag + active resize; fades when the user
  // is just hovering a committed selection.
  const gridActive =
    phase === "dragging" || activeResize !== null || hoverResize !== null;

  const showSettleAnim = phase === "selected" && settleKey > 0;

  // When the selection is small enough to trigger the magnified preview (which
  // carries its own px readout), suppress this badge so the size isn't shown
  // twice. Gated on the snapshot being loaded — that's what the preview needs
  // to render, so the badge stays as the fallback until then.
  const previewShown = snapshotReady && isTinySelection(renderRect);

  return (
    <div
      onPointerMove={onSelectionPointerMove}
      onPointerUp={onSelectionPointerUp}
      onPointerDown={(e) => {
        if (!editable) return;
        e.stopPropagation();
        beginMove(renderRect, e);
      }}
      key={`sel-${settleKey}`}
      className={`absolute ${showSettleAnim ? "ovl-edge-settle" : ""}`}
      style={{
        left: renderRect.x,
        top: renderRect.y,
        width: renderRect.w,
        height: renderRect.h,
        // Layered shadows:
        //   1. dim everything outside the rect via 100vmax spread.
        //   2. soft outer accent halo around the rect (the "glow").
        //   3. crisp inner accent ring for a tactile edge.
        boxShadow: [
          `0 0 0 100vmax rgba(8,12,20,${editable ? "0.68" : "0.52"})`,
          editable
            ? `0 0 28px 4px color-mix(in srgb, var(--color-accent) ${activeResize ? 38 : 24}%, transparent)`
            : "",
          editable
            ? "0 0 0 1px color-mix(in srgb, var(--color-accent) 55%, transparent)"
            : "",
        ]
          .filter(Boolean)
          .join(", "),
        transition: "box-shadow 200ms cubic-bezier(0.16,1,0.3,1)",
        cursor: editable ? "move" : "none",
        border: "1.25px dashed var(--color-accent)",
        zIndex: 15,
      }}
    >
      {/* Snap pulse — bumped by useRegionSelection when the rect snaps
          to a viewport edge or aspect-locked corner. Keyed on the
          counter so React replays the animation every fire. */}
      {snapPulse > 0 && (
        <div
          key={`pulse-${snapPulse}`}
          aria-hidden
          className="ovl-snap-pulse pointer-events-none absolute -inset-px rounded-[1px]"
        />
      )}

      {/* Rule-of-thirds grid — fades when idle to reduce visual noise. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: gridActive ? 1 : 0.38,
          transition: "opacity 180ms cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        {[33.333, 66.666].map((p) => (
          <div
            key={`v${p}`}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${p}%`,
              width: 1,
              background:
                "repeating-linear-gradient(to bottom, rgba(255,255,255,0.18) 0 4px, transparent 4px 8px)",
            }}
          />
        ))}
        {[33.333, 66.666].map((p) => (
          <div
            key={`h${p}`}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: `${p}%`,
              height: 1,
              background:
                "repeating-linear-gradient(to right, rgba(255,255,255,0.18) 0 4px, transparent 4px 8px)",
            }}
          />
        ))}
      </div>

      {/* Active-edge highlight stripes — rendered only for the edges /
          corners the user is currently dragging. */}
      {editable && activeResize && (
        <ActiveEdgeHighlight dir={activeResize} rect={renderRect} />
      )}

      {/* Size badge — physical pixels per legacy convention. Lifted
          above the rect so it never blocks an active corner handle. Hidden
          when the magnified preview is up (it shows the size itself). */}
      {!previewShown && (
        <div
          className="absolute -top-7 left-0 rounded-md bg-[var(--color-accent)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--color-accent-ink)] shadow-[var(--shadow-medium)]"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {Math.round(renderRect.w * dpr)} × {Math.round(renderRect.h * dpr)}
        </div>
      )}

      {editable &&
        sizedHandles.map((h) => {
          const isActive = activeResize === h.dir;
          const isHover = hoverResize === h.dir && !activeResize;
          // Edge handles get a thin pill shape; corner handles stay
          // circular. Pills better communicate the resize axis. Sizes are
          // pre-scaled (see `handleScale`) so they shrink with a small box.
          const isEdge =
            h.dir === "n" || h.dir === "s" || h.dir === "e" || h.dir === "w";
          const horizontal = h.dir === "n" || h.dir === "s";
          const handleStyle: CSSProperties = isEdge
            ? {
                width: horizontal ? edgeLong : edgeThick,
                height: horizontal ? edgeThick : edgeLong,
                borderRadius: 999,
              }
            : {
                width: cornerSize,
                height: cornerSize,
                borderRadius: "50%",
              };
          return (
            <span
              key={h.dir}
              className="ovl-handle"
              data-active={isActive ? "true" : "false"}
              data-hover={isHover ? "true" : "false"}
              onPointerDown={(e) => beginResize(renderRect, h.dir, e)}
              onPointerEnter={() => setHoverResize(h.dir)}
              onPointerLeave={() => setHoverResize(null)}
              style={{
                position: "absolute",
                left: h.left,
                top: h.top,
                transform: "translate(-50%, -50%)",
                background: "var(--color-accent)",
                boxShadow: "0 0 0 2px white, 0 2px 6px rgba(0,0,0,0.25)",
                cursor: RESIZE_CURSORS[h.dir],
                // Invisible expanded hit zone via outline-style padding.
                outline: `${HIT_PAD}px solid transparent`,
                outlineOffset: `-${HIT_PAD}px`,
                ...handleStyle,
              }}
            />
          );
        })}
    </div>
  );
}

/**
 * Bright accent stripes along the edge / corner currently being
 * resized. Renders inside the selection rect — coordinates are local.
 */
function ActiveEdgeHighlight({ dir, rect }: { dir: ResizeDir; rect: Rect }) {
  const thickness = 2;
  const stripe: CSSProperties = {
    position: "absolute",
    background:
      "linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 0%, transparent), var(--color-accent) 50%, color-mix(in srgb, var(--color-accent) 0%, transparent))",
    boxShadow:
      "0 0 10px 1.5px color-mix(in srgb, var(--color-accent) 55%, transparent)",
    pointerEvents: "none",
  };
  const stripeV: CSSProperties = {
    ...stripe,
    background:
      "linear-gradient(180deg, color-mix(in srgb, var(--color-accent) 0%, transparent), var(--color-accent) 50%, color-mix(in srgb, var(--color-accent) 0%, transparent))",
  };
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {dir.includes("n") && (
        <span
          style={{
            ...stripe,
            left: 0,
            right: 0,
            top: -thickness / 2,
            height: thickness,
          }}
        />
      )}
      {dir.includes("s") && (
        <span
          style={{
            ...stripe,
            left: 0,
            right: 0,
            bottom: -thickness / 2,
            height: thickness,
          }}
        />
      )}
      {dir.includes("w") && (
        <span
          style={{
            ...stripeV,
            top: 0,
            bottom: 0,
            left: -thickness / 2,
            width: thickness,
          }}
        />
      )}
      {dir.includes("e") && (
        <span
          style={{
            ...stripeV,
            top: 0,
            bottom: 0,
            right: -thickness / 2,
            width: thickness,
          }}
        />
      )}
      {/* Pulse the corner being grabbed. */}
      {(dir === "nw" || dir === "ne" || dir === "sw" || dir === "se") && (
        <span
          style={{
            position: "absolute",
            left: dir.includes("w") ? -3 : rect.w - 3,
            top: dir.includes("n") ? -3 : rect.h - 3,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--color-accent)",
            boxShadow:
              "0 0 12px 4px color-mix(in srgb, var(--color-accent) 55%, transparent)",
          }}
        />
      )}
    </div>
  );
}
