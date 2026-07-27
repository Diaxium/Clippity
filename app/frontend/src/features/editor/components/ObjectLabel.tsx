import { rotatedAABB } from "../geometry";
import {
  chromeSide,
  CHROME_BOTTOM_RAIL,
  CHROME_MARGIN,
} from "../lib/selectionChrome";
import { useEditorStore } from "../state/editorStore";
import type { Viewport } from "../state/editorStore";
import type { SceneNode } from "../types";
import { TYPE_ICON } from "./LayersTree";

/** The action toolbar's measured height (`p-1` + stacked icon-over-label
 *  buttons + 1px border). We predict the toolbar's side with the same height it
 *  measures so the label reliably takes the *opposite* side. */
const TOOLBAR_H = 52;
/** Gap from the selection edge, and the label pill's own height (12px text +
 *  `py-1.5`) — used to keep the label clear of the canvas edge / bottom rail. */
const LABEL_GAP = 10;
const LABEL_H = 26;

/** A compact descriptor for the selection: the layer's name plus its size,
 *  e.g. `Screenshot · 1920×1080`, `Heading · 24px`. Pure — exported for tests. */
export function objectLabelText(node: SceneNode): string {
  const w = Math.round(node.width);
  const h = Math.round(node.height);
  switch (node.type) {
    case "text":
      return `${node.name} · ${Math.round(node.fontSize)}px`;
    case "line":
    case "arrow":
      return node.name;
    default:
      return `${node.name} · ${w}×${h}`;
  }
}

interface ObjectLabelProps {
  /** The single selected node, or null when 0 / many are selected. */
  node: SceneNode | null;
  viewport: Viewport;
  /** Hidden during a gesture (the transform readout takes over) or multi-select. */
  hidden: boolean;
}

/**
 * A small chip centered just below the selection, naming what's selected and
 * its size. Purely informational (pointer-events: none).
 *
 * Rendered on the neutral floating surface rather than filled with the accent,
 * which is what it used to be: the selection outline it sits against is already
 * accent-colored, so an accent chip touching an accent outline read as part of
 * the selection geometry — a handle, or a resize affordance — instead of a
 * readout. The type icon replaces the accent as the thing that identifies it.
 */
export function ObjectLabel({ node, viewport, hidden }: ObjectLabelProps) {
  const canvasSize = useEditorStore((s) => s.canvasSize);
  if (!node || hidden) return null;
  const { zoom, panX, panY } = viewport;
  const b = rotatedAABB(node);
  const cx = (b.x + b.width / 2) * zoom + panX;
  const topY = b.y * zoom + panY;
  const bottomY = (b.y + b.height) * zoom + panY;

  // The toolbar prefers above the selection; the label takes the opposite
  // side so the two never stack. When the toolbar is forced below (or pinned
  // for a viewport-spanning selection), the label flips above — keeping the
  // size readout visible for large screenshots instead of vanishing into the
  // rail the way it used to.
  const toolbarSide = chromeSide(topY, bottomY, canvasSize.height, TOOLBAR_H);
  const railTop = canvasSize.height - CHROME_BOTTOM_RAIL;

  let top: number;
  let translateY: string;
  if (toolbarSide === "above") {
    // Toolbar above → label below the selection.
    top = bottomY + LABEL_GAP;
    translateY = "0";
    if (top + LABEL_H > railTop) return null; // no room below the selection
  } else {
    // Toolbar below / pinned → label above the selection.
    top = topY - LABEL_GAP;
    translateY = "-100%";
    if (topY - LABEL_GAP - LABEL_H < CHROME_MARGIN) return null;
  }

  const Icon = TYPE_ICON[node.type];

  return (
    <div
      className="pointer-events-none absolute z-10 flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border border-[color:var(--ed-hairline-strong)] px-2 py-1.5 text-[12px] font-medium tabular-nums"
      style={{
        left: cx,
        top,
        transform: `translateX(-50%) translateY(${translateY})`,
        background: "var(--float-bg)",
        color: "var(--ed-text)",
        boxShadow: "var(--shadow-subtle)",
      }}
    >
      <Icon
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-[var(--ed-text-dim)]"
      />
      {objectLabelText(node)}
    </div>
  );
}
