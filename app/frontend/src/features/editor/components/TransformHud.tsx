import { Lock } from "lucide-react";

import { useEditorStore } from "../state/editorStore";

/**
 * A live transform readout (W×H while resizing, position while moving, angle
 * while rotating) anchored just below the selection. Self-subscribes to the
 * transient `transformHud` + viewport so it updates every frame during a
 * gesture without re-rendering the scene. Null when no gesture is active.
 *
 * During a proportional resize (Shift held, or the node's aspect locked) it
 * shows a small lock glyph so the constraint is visible without a heavy overlay.
 */
export function TransformHud() {
  const hud = useEditorStore((s) => s.transformHud);
  const viewport = useEditorStore((s) => s.viewport);
  if (!hud) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 inline-flex items-center gap-1 whitespace-nowrap rounded-[var(--radius-sm)] px-2 py-1 text-[11px] font-medium tabular-nums"
      style={{
        left: hud.sx * viewport.zoom + viewport.panX,
        top: hud.sy * viewport.zoom + viewport.panY + 10,
        transform: "translateX(-50%)",
        background: "var(--ed-accent)",
        color: "var(--ed-on-accent)",
        boxShadow: "var(--shadow-subtle)",
      }}
      role="status"
    >
      {hud.aspectLocked && (
        <Lock size={10} strokeWidth={2.25} aria-label="Aspect ratio locked" />
      )}
      {hud.text}
    </div>
  );
}
