import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { X } from "lucide-react";

import { rotatedAABB } from "../geometry";
import { dockTargetAt, type DockSide } from "../lib/dock";
import { chromeXPos, chromeXSide } from "../lib/selectionChrome";
import { useEditorStore } from "../state/editorStore";
import type { EditorMode } from "../types";
import {
  InspectorSections,
  InspectorTabs,
  SelectionSummary,
} from "./InspectorSections";

/** Panel width; also the width fed to the horizontal placement helper. */
const PANEL_W = 264;
/** Keep the panel clear of the top bar and the canvas bottom rail. */
const TOP_MARGIN = 8;
const BOTTOM_RAIL = 56;

/**
 * The inspector in its floating form — a panel over the canvas rather than a
 * rail beside it. Annotation defaults to this (the canvas is the point there),
 * but either mode can be dragged into it.
 *
 * Three behaviours matter:
 *
 * 1. **Horizontal anchoring.** The vertical axis is already arbitrated between
 *    `FloatingToolbar` (one side) and `ObjectLabel` (the other) via
 *    `chromeSide`. Anchoring left/right of the selection with `chromeXSide`
 *    keeps this panel out of that negotiation instead of making it three-way.
 *
 * 2. **Anchor once, then stay put.** Position is recomputed when the *selection
 *    identity* changes, not on every viewport or geometry tick, so the panel
 *    doesn't crawl under the cursor while a mark is dragged or resized.
 *
 * 3. **Snap to dock.** Dragging the header near a workspace edge previews a
 *    drop zone; releasing there re-attaches the panel as a rail. This is the
 *    return trip for `InspectorPanel`'s undock pull, and the reason floating is
 *    not a one-way door.
 */
export function FloatingInspector({ mode }: { mode: EditorMode }) {
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const nodes = useEditorStore((s) => s.nodes);
  const viewport = useEditorStore((s) => s.viewport);
  const canvasSize = useEditorStore((s) => s.canvasSize);
  const setInspectorDock = useEditorStore((s) => s.setInspectorDock);
  const setDockPreview = useEditorStore((s) => s.setDockPreview);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  // Latest previewed edge, mirrored locally so pointer-up can act on it without
  // re-subscribing to the store mid-drag.
  const target = useRef<DockSide | null>(null);

  // Identity of the selection, not its geometry — the "anchor once" trigger.
  const selKey = selectedIds.join(",");
  const hasSelection = selectedIds.length > 0;

  useEffect(() => setDismissed(false), [selKey]);

  // A panel that unmounts mid-drag must not strand the drop-zone highlight.
  useEffect(() => () => setDockPreview(null), [setDockPreview]);

  useLayoutEffect(() => {
    if (!hasSelection) {
      setPos(null);
      return;
    }
    const sel = selectedIds.map((id) => nodes[id]).filter(Boolean);
    if (sel.length === 0) return;

    const boxes = sel.map((n) => rotatedAABB(n!));
    const minX = Math.min(...boxes.map((b) => b.x));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const minY = Math.min(...boxes.map((b) => b.y));
    const { zoom, panX, panY } = viewport;
    const leftX = minX * zoom + panX;
    const rightX = maxX * zoom + panX;

    const side = chromeXSide(leftX, rightX, canvasSize.width, PANEL_W);
    const left = chromeXPos(side, leftX, rightX, canvasSize.width, PANEL_W);

    const h = ref.current?.getBoundingClientRect().height ?? 0;
    const maxTop = Math.max(TOP_MARGIN, canvasSize.height - BOTTOM_RAIL - h);
    const top = Math.min(Math.max(minY * zoom + panY, TOP_MARGIN), maxTop);
    setPos({ left, top });
    // Intentionally keyed on selection identity + canvas size only: viewport
    // pans/zooms and node geometry must NOT re-anchor an already-placed panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, canvasSize.width, canvasSize.height, hasSelection]);

  if (!hasSelection || dismissed || !pos) return null;

  /** Workspace bounds the snap is measured against — the canvas area itself,
   *  so an edge means "the edge of the space a rail would occupy". */
  const workspaceRect = (): { left: number; right: number } => {
    const area = ref.current?.closest("[data-canvas-area]");
    if (!area) return { left: 0, right: window.innerWidth };
    const r = area.getBoundingClientRect();
    return { left: r.left, right: r.right };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos({ left: e.clientX - d.dx, top: e.clientY - d.dy });
    const { left, right } = workspaceRect();
    const next = dockTargetAt(e.clientX, left, right);
    target.current = next;
    setDockPreview(next);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (target.current) setInspectorDock(mode, target.current);
    else setDockPreview(null);
    target.current = null;
  };

  return (
    <div
      ref={ref}
      data-floating-inspector
      role="group"
      aria-label="Inspector"
      style={{ left: pos.left, top: pos.top, width: PANEL_W }}
      className="absolute z-30 flex max-h-[calc(100%-64px)] flex-col overflow-hidden rounded-[10px] border border-[color:var(--ed-hairline)] bg-[var(--ed-panel)] shadow-lg"
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag to move — release near an edge to dock"
        className="flex cursor-grab items-center active:cursor-grabbing"
      >
        <div className="min-w-0 flex-1">
          <SelectionSummary />
        </div>
        <button
          type="button"
          title="Close"
          aria-label="Close inspector"
          onClick={() => setDismissed(true)}
          className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <InspectorTabs />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <InspectorSections mode={mode} />
      </div>
    </div>
  );
}

/**
 * Edge highlight shown while a floating panel is dragged within snapping range.
 * Rendered inside the canvas area so it lines up with where the rail will land.
 */
export function DockDropZone() {
  const dockPreview = useEditorStore((s) => s.dockPreview);
  const panelWidth = useEditorStore((s) => s.panelWidth);
  if (!dockPreview) return null;
  return (
    <div
      data-dock-drop-zone={dockPreview}
      aria-hidden
      style={{ width: panelWidth }}
      className={
        "pointer-events-none absolute inset-y-0 z-20 border-2 border-[var(--ed-accent)] bg-[var(--ed-accent)]/10 " +
        (dockPreview === "right" ? "right-0" : "left-0")
      }
    />
  );
}
