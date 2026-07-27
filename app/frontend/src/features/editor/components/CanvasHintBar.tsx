import { useEditorStore, type GestureKind } from "../state/editorStore";
import { TOOL_BY_ID } from "../tools";
import type { ToolId } from "../types";

/**
 * Resolve the contextual hint for the canvas. Gesture state wins (it's the most
 * specific), then the active tool, then the selection. Returns null when no
 * hint helps (e.g. panning), which hides the bar.
 */
export function canvasHint(
  tool: ToolId,
  selectedCount: number,
  gesture: GestureKind | null
): string | null {
  switch (gesture) {
    case "resize":
      return "Drag to resize · Shift keeps aspect ratio · Alt from center";
    case "rotate":
      return "Drag to rotate · Shift snaps to 15°";
    case "endpoint":
      return "Drag the endpoint · Shift to constrain";
    case "move":
      return "Drag to move · Shift to constrain · Alt to duplicate";
    case "draw":
      return "Drag to draw · Shift to constrain";
    case "marquee":
      return "Drag to select";
    case "crop":
      return "Drag to crop · Shift keeps the ratio";
    case "pan":
      return null;
    default:
      break;
  }
  if (tool === "crop")
    return "Drag the edges to crop · Enter to apply · Esc to cancel";
  if (tool === "text") return "Click to add text, or drag a text box";
  if (tool === "image") return "Click to place an image";
  if (tool === "hand") return "Drag to pan the canvas";
  if (tool === "pencil") return "Drag to draw freehand";
  if (tool === "pen")
    return "Click to add points · Enter to finish · Esc to cancel";
  const def = TOOL_BY_ID[tool];
  if (def?.draws) return `Drag to draw a ${def.label.toLowerCase()}`;
  return selectedCount > 0
    ? "Drag to move · Shift to constrain · Alt to duplicate"
    : "Select a layer or drag an image here";
}

/**
 * A quiet, contextual hint pinned bottom-center of the canvas. Built from the
 * floating-surface tokens (`--float-bg`, `--ed-hairline`, `--shadow-subtle`)
 * and `--ed-text-dim`, so it never competes with the content.
 */
export function CanvasHintBar() {
  const tool = useEditorStore((s) => s.tool);
  const selectedCount = useEditorStore((s) => s.selectedIds.length);
  const gesture = useEditorStore((s) => s.activeGesture);

  const hint = canvasHint(tool, selectedCount, gesture);
  if (!hint) return null;

  return (
    <div
      className="pointer-events-none max-w-full truncate rounded-[var(--radius-md)] border border-[color:var(--ed-hairline)] px-3 py-1.5 text-[11.5px]"
      style={{
        background: "var(--float-bg)",
        color: "var(--ed-text-dim)",
        boxShadow: "var(--shadow-subtle)",
      }}
      role="status"
    >
      {hint}
    </div>
  );
}
