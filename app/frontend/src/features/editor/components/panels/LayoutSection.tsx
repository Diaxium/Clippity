import { Link2 } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { useSelection, selectionIds } from "../../hooks/useSelection";
import { shared, toggleTarget, triState } from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import { isLineLike, nodeBounds, type SceneNode } from "../../types";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

/**
 * Dimensions (W/H) with a lock-aspect toggle, plus clip-content for frames.
 * Editing one dimension while locked scales the other proportionally.
 *
 * Multi-select (P3) resizes every selected node to the typed dimension. The
 * aspect lock is **per node**, not the primary's — three locked shapes with
 * different ratios each keep their own — which is why this writes through
 * `updateEach` (a patch derived from the node it lands on) rather than
 * `updateNodes`' single shared patch.
 */
export function LayoutSection() {
  const updateEach = useEditorStore((s) => s.updateEach);
  const updateNodes = useEditorStore((s) => s.updateNodes);

  const sel = useSelection();

  const node = sel[0];
  if (!node) return null;
  const ids = selectionIds(sel);

  const width = shared(sel, (n) => nodeBounds(n).width)!;
  const height = shared(sel, (n) => nodeBounds(n).height)!;
  // The toggle is offered when *anything* selected can carry it; line-like
  // nodes sit out the write below rather than hiding the control for everyone.
  const lockable = sel.some((n) => !isLineLike(n));
  const lockAspect = triState(sel, (n) => n.lockAspect);

  // Frames are the only nodes that clip, so the row appears when the selection
  // contains one and writes to just those.
  const frameIds = sel.filter((n) => n.type === "frame").map((n) => n.id);
  const clip = triState(
    sel.filter((n) => n.type === "frame"),
    (n) => (n as Extract<SceneNode, { type: "frame" }>).clipContent
  );

  /** Resize each node on its own ratio, driving the other axis when locked. */
  const resize = (axis: "width" | "height", v: number) =>
    updateEach(ids, (n) => {
      const b = nodeBounds(n);
      const ratio = b.height > 0 ? b.width / b.height : 0;
      if (!n.lockAspect || !ratio) {
        return axis === "width" ? { width: v } : { height: v };
      }
      return axis === "width"
        ? { width: v, height: Math.max(1, Math.round(v / ratio)) }
        : { height: v, width: Math.max(1, Math.round(v * ratio)) };
    });

  return (
    <PanelSection id="layout" title="Layout">
      <p className={FIELD_LABEL}>Dimensions</p>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <NumberField
            label="W"
            min={1}
            value={width.value}
            mixed={width.mixed}
            onChange={(v) => resize("width", v)}
          />
        </div>
        <div className="min-w-0 flex-1">
          <NumberField
            label="H"
            min={1}
            value={height.value}
            mixed={height.mixed}
            onChange={(v) => resize("height", v)}
          />
        </div>
        {lockable && (
          <button
            type="button"
            title={
              lockAspect === "on" ? "Unlock aspect ratio" : "Lock aspect ratio"
            }
            aria-label="Lock aspect ratio"
            aria-pressed={lockAspect === "on"}
            onClick={() => {
              const lock = toggleTarget(lockAspect);
              updateEach(ids, (n) =>
                isLineLike(n) ? null : { lockAspect: lock }
              );
            }}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]",
              lockAspect === "on"
                ? "bg-[var(--ed-accent)] text-[var(--ed-on-accent)]"
                : "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
            )}
          >
            <Link2 size={15} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {frameIds.length > 0 && (
        <label className="mt-2.5 flex items-center gap-2 text-[12px] text-[var(--ed-text)]">
          <input
            type="checkbox"
            checked={clip === "on"}
            ref={(el) => {
              // A split selection shows the OS indeterminate mark rather than
              // claiming a state half the frames don't have.
              if (el) el.indeterminate = clip === "mixed";
            }}
            onChange={() =>
              updateNodes(frameIds, { clipContent: toggleTarget(clip) })
            }
            className="accent-[var(--ed-accent)]"
          />
          Clip content
        </label>
      )}
    </PanelSection>
  );
}
