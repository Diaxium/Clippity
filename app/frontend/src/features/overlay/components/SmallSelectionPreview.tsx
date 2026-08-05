import type { PointerEvent as PointerEventReact } from "react";
import { Move } from "lucide-react";

import { rectFromPoints } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";
import type { Rect } from "../types";

/** A selection whose larger side is below this (logical px) is too small to
 *  read at 1×, so we float a magnified content preview beside it. Matches the
 *  threshold the user reported ("anything under 45 pixels"). */
export const SMALL_THRESHOLD = 45;

/**
 * Whether a selection is small enough that the magnified preview takes over —
 * which also means the selection's own size badge should hide (the preview
 * carries its own px readout, so showing both is a duplicate). Exported so
 * `RegionSelection` can suppress its badge in lock-step with this component.
 */
export function isTinySelection(rect: Rect | null): boolean {
  return (
    !!rect &&
    rect.w >= 1 &&
    rect.h >= 1 &&
    Math.max(rect.w, rect.h) < SMALL_THRESHOLD
  );
}
/** Target for the preview's larger side (logical px) — how big the zoomed crop
 *  is drawn. */
const PREVIEW_MAX = 160;
/** Cap the magnification so an extremely tiny (near-`MIN_SIZE`) selection
 *  doesn't blow up into a wall of giant pixels. */
const MAX_ZOOM = 14;
const GAP = 16; // gap between the selection box (or action bar) and the preview
const EDGE_PAD = 12;
const TOOLBAR_RESERVE = 80; // keep clear of the bottom toolbar zone
const LABEL_H = 18; // the px-readout chip below the preview image

/**
 * Zoomed content preview for a *small* region selection.
 *
 * When the selection box's larger side is under {@link SMALL_THRESHOLD} px the
 * user can't actually see what's inside it — and the cursor loupe disappears
 * the moment the selection commits (`selected` phase), leaving a tiny box with
 * no way to confirm its contents. This floats a magnified view of the
 * selection's pixels — sampled from the same cached desktop snapshot the loupe
 * uses — beside the box, both while dragging a tiny region and after it
 * commits.
 *
 * Self-gating: renders nothing unless a region-like selection exists, it is
 * genuinely small, and the snapshot has loaded. Once the selection commits it
 * doubles as a drag-to-move handle (see {@link SmallSelectionPreviewProps}).
 */
interface SmallSelectionPreviewProps {
  /** Move handlers from `useRegionSelection`. When supplied, the magnified view
   *  becomes a drag-to-move handle in the committed phase — a tiny box's resize
   *  handles cover its entire body, leaving nowhere to grab to move it, so this
   *  larger surface takes over the move gesture. */
  beginMove?: (rect: Rect, e: PointerEventReact) => void;
  onSelectionPointerMove?: (e: PointerEventReact) => void;
  onSelectionPointerUp?: () => void;
}

export function SmallSelectionPreview({
  beginMove,
  onSelectionPointerMove,
  onSelectionPointerUp,
}: SmallSelectionPreviewProps = {}) {
  const mode = useOverlayStore((s) => s.mode);
  const phase = useOverlayStore((s) => s.phase);
  const start = useOverlayStore((s) => s.start);
  const cur = useOverlayStore((s) => s.cur);
  const committed = useOverlayStore((s) => s.rect);
  const dataUri = useOverlayStore((s) => s.snapshot.url);
  const sampleCtx = useOverlayStore((s) => s.snapshot.sampleCtx);

  // The live drag rect (dragging) or the committed rect (selected).
  const rect: Rect | null =
    phase === "dragging" && start && cur
      ? rectFromPoints(start, cur)
      : committed;

  if (!rect || !dataUri || !sampleCtx) return null;
  if (phase !== "dragging" && phase !== "selected") return null;
  // A comfortably-sized selection shows its own contents fine — only help when
  // the whole box is small.
  if (!isTinySelection(rect)) return null;

  const dpr = window.devicePixelRatio || 1;
  const longSide = Math.max(rect.w, rect.h);
  const zoom = Math.min(PREVIEW_MAX / longSide, MAX_ZOOM);
  const cw = Math.round(rect.w * zoom);
  const ch = Math.round(rect.h * zoom);

  // The cached snapshot spans the whole overlay window (OverlayLayout stretches
  // it 100%/100%), so 1 logical desktop px maps to `dpr` snapshot px. Scale the
  // background so 1 logical px → `zoom` preview px, then offset to the rect's
  // top-left — same windowing trick the magnifier uses, framed to the
  // selection instead of a cursor-centred sample window.
  const bgW = (sampleCtx.canvas.width / dpr) * zoom;
  const bgH = (sampleCtx.canvas.height / dpr) * zoom;
  const bgX = -rect.x * zoom;
  const bgY = -rect.y * zoom;

  // The contextual action bar (Copy / Save / Edit & annotate …) renders just
  // outside the selection in region mode once it commits — give the preview its
  // rect so placement steers clear of it.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const actionBar =
    mode === "region" && phase === "selected"
      ? actionBarRect(rect, vw, vh)
      : null;
  const { left, top } = place(rect, cw, ch, vw, vh, actionBar);

  // Physical px, matching the selection size badge's convention.
  const physW = Math.round(rect.w * dpr);
  const physH = Math.round(rect.h * dpr);

  // Once committed, the magnified view is the move handle (the resize handles
  // own the tiny box itself). Stays presentational while dragging out the box.
  const movable = phase === "selected" && !!beginMove;

  return (
    <div
      aria-hidden
      className="ovl-small-preview pointer-events-none absolute z-30"
      style={{ left, top }}
    >
      <div
        data-move-handle={movable ? "true" : undefined}
        onPointerDown={movable ? (e) => beginMove!(rect, e) : undefined}
        onPointerMove={movable ? onSelectionPointerMove : undefined}
        onPointerUp={movable ? onSelectionPointerUp : undefined}
        style={{
          position: "relative",
          width: cw,
          height: ch,
          borderRadius: 8,
          overflow: "hidden",
          border: "1.5px solid color-mix(in srgb, white 70%, transparent)",
          boxShadow:
            "0 0 0 1px rgba(0,0,0,0.35), 0 12px 30px rgba(0,0,0,0.42), 0 0 0 3px color-mix(in srgb, var(--color-accent) 32%, transparent)",
          backgroundImage: `url(${dataUri})`,
          backgroundRepeat: "no-repeat",
          backgroundSize: `${bgW}px ${bgH}px`,
          backgroundPosition: `${bgX}px ${bgY}px`,
          imageRendering: "pixelated",
          // Become the move handle when committed; otherwise let pointers through.
          pointerEvents: movable ? "auto" : "none",
          cursor: movable ? "move" : undefined,
          touchAction: movable ? "none" : undefined,
        }}
      >
        {movable && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-md bg-black/55 text-white"
          >
            <Move size={12} strokeWidth={2} />
          </span>
        )}
      </div>
      <div className="mt-1 text-center">
        <span className="rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
          {physW} × {physH}
        </span>
      </div>
    </div>
  );
}

/**
 * Place the preview centred horizontally on the selection and stacked above or
 * below it — on the vertical side *opposite* the contextual action bar, which
 * is wide (≈250 px) and centred on the selection, so the only reliable way to
 * miss it is to keep the preview on a different row. Falls back to stacking
 * beyond the bar (then the other side) when the preferred side is off-screen,
 * scoring candidates by how much they'd overlap the bar / selection / bottom
 * toolbar. Exported for unit testing.
 *
 * @param actionBar the action bar's rect to avoid, or `null` when it isn't
 *   shown (mid-drag, or non-region modes) — then the preview simply prefers
 *   above the selection.
 */
export function place(
  rect: Rect,
  cw: number,
  ch: number,
  vw: number,
  vh: number,
  actionBar: Rect | null = null
): { left: number; top: number } {
  const boxW = cw;
  const boxH = ch + LABEL_H;
  const left = clampNum(
    rect.x + rect.w / 2 - boxW / 2,
    EDGE_PAD,
    Math.max(EDGE_PAD, vw - EDGE_PAD - boxW)
  );
  const toolbar: Rect = {
    x: 0,
    y: vh - TOOLBAR_RESERVE,
    w: vw,
    h: TOOLBAR_RESERVE,
  };

  const above = rect.y - GAP - boxH;
  const below = rect.y + rect.h + GAP;
  const barIsBelow = actionBar !== null && actionBar.y >= rect.y + rect.h / 2;
  // Preferred side opposite the bar, then stacked beyond the bar, then the
  // remaining side. No bar → just prefer above the selection.
  const candidateTops = !actionBar
    ? [above, below]
    : barIsBelow
      ? [above, actionBar.y + actionBar.h + GAP, below]
      : [below, actionBar.y - GAP - boxH, above];

  const maxTop = Math.max(EDGE_PAD, vh - EDGE_PAD - boxH);
  let bestTop = clampNum(candidateTops[0]!, EDGE_PAD, maxTop);
  let bestPenalty = Infinity;
  for (const t of candidateTops) {
    const top = clampNum(t, EDGE_PAD, maxTop);
    const box: Rect = { x: left, y: top, w: boxW, h: boxH };
    const penalty =
      (actionBar ? overlapArea(box, actionBar) * 4 : 0) +
      overlapArea(box, rect) * 3 +
      overlapArea(box, toolbar) * 2 +
      Math.abs(top - t); // penalize being clamped away from the ideal spot
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestTop = top;
    }
    if (penalty === 0) break; // a clean placement; no need to keep looking
  }
  return { left, top: bestTop };
}

/**
 * The contextual action bar's rect — mirrors `SelectionActionBar`'s own
 * positioning (centred on the selection, 12 px below by default, flipping above
 * near the bottom toolbar). Kept in lock-step with that component so the preview
 * avoids exactly where the bar lands.
 */
function actionBarRect(rect: Rect, vw: number, vh: number): Rect {
  const BAR_W = 250;
  const BAR_H = 44;
  const BAR_GUTTER = 12;
  let y = rect.y + rect.h + BAR_GUTTER;
  if (y + BAR_H > vh - TOOLBAR_RESERVE) y = rect.y - BAR_H - BAR_GUTTER;
  if (y < 14) y = Math.max(rect.y + 8, 14);
  const x = clampNum(
    rect.x + rect.w / 2 - BAR_W / 2,
    14,
    Math.max(14, vw - BAR_W - 14)
  );
  return { x, y, w: BAR_W, h: BAR_H };
}

function clampNum(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Intersection area of two rects (0 when disjoint). */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}
