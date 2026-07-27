import type { Viewport } from "../state/editorStore";
import { hasCornerRadius, type SceneNode } from "../types";

interface SelectionShadowProps {
  /** The single selected node, or null when 0 / many are selected. */
  node: SceneNode | null;
  viewport: Viewport;
}

/**
 * A soft drop shadow drawn *behind* the selected content node so it reads as
 * lifted off the recessed canvas. Rendered as an HTML box (matching the node's
 * screen rect + rotation + radius) so it can use the app's `--shadow-medium`
 * token directly. Only content nodes (image/frame) get a lift — their opaque
 * body hides the box and leaves just the halo; transparent shapes rely on their
 * outline instead.
 */
export function SelectionShadow({ node, viewport }: SelectionShadowProps) {
  if (!node || (node.type !== "image" && node.type !== "frame")) return null;
  const { zoom, panX, panY } = viewport;
  const radius = hasCornerRadius(node) ? node.cornerRadius * zoom : 0;
  return (
    <div
      className="ed-selection-lift pointer-events-none absolute"
      aria-hidden
      style={{
        left: node.x * zoom + panX,
        top: node.y * zoom + panY,
        width: node.width * zoom,
        height: node.height * zoom,
        borderRadius: radius,
        transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
        transformOrigin: "center",
      }}
    />
  );
}
