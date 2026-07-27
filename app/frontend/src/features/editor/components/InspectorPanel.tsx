import { useRef } from "react";

import { GripVertical } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { shouldUndock, type DockSide } from "../lib/dock";
import { useEditorStore } from "../state/editorStore";
import type { EditorMode } from "../types";
import {
  InspectorEmpty,
  InspectorSections,
  InspectorTabs,
  SelectionSummary,
} from "./InspectorSections";

const MODE_LABEL: Record<EditorMode, string> = {
  annotate: "Style",
  design: "Design",
};

/**
 * Drag handle on the inspector's inner edge. Pointer capture keeps the drag
 * alive outside the strip, and width is derived from the viewport edge rather
 * than accumulated deltas so the panel can't drift from the cursor.
 */
function ResizeHandle({ side }: { side: DockSide }) {
  const setPanelWidth = useEditorStore((s) => s.setPanelWidth);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        setPanelWidth(
          side === "right" ? window.innerWidth - e.clientX : e.clientX
        );
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      className={cn(
        "absolute inset-y-0 z-10 w-1 cursor-col-resize hover:bg-[var(--ed-accent)]",
        side === "right" ? "left-0" : "right-0"
      )}
    />
  );
}

/**
 * The inspector in its docked form: a rail attached to one edge of the
 * workspace. Its header doubles as an undock grip — pulling it inward past
 * {@link shouldUndock}'s threshold floats the panel, which is the return trip
 * for the snap-to-dock gesture in `FloatingInspector`.
 *
 * Undocking is a *pull*, not a click, and its threshold is deliberately larger
 * than the dock snap radius so the two gestures can't oscillate at the boundary.
 */
export function InspectorPanel({
  mode,
  side,
}: {
  mode: EditorMode;
  side: DockSide;
}) {
  const hasSelection = useEditorStore((s) => s.selectedIds.length > 0);
  const panelWidth = useEditorStore((s) => s.panelWidth);
  const setInspectorDock = useEditorStore((s) => s.setInspectorDock);
  const startX = useRef<number | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (startX.current == null) return;
    if (shouldUndock(side, startX.current, e.clientX)) {
      startX.current = null;
      setInspectorDock(mode, null);
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    startX.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <aside
      data-inspector-dock={side}
      style={{ width: panelWidth }}
      className={cn(
        "relative flex h-full shrink-0 flex-col overflow-hidden bg-[var(--ed-panel)]",
        side === "right"
          ? "border-l border-[color:var(--ed-hairline)]"
          : "border-r border-[color:var(--ed-hairline)]"
      )}
    >
      <ResizeHandle side={side} />
      {/* The selection header doubles as the undock grip — the panel already
          spends a full row naming what's selected, and a second row whose only
          job was to be draggable was pure chrome. With nothing selected it
          falls back to the mode label so the grip never disappears. */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Undock inspector"
        title="Drag inward to float this panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(e) => {
          // Keyboard parity for a drag-only affordance.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setInspectorDock(mode, null);
          }
        }}
        className="group flex shrink-0 cursor-grab items-center active:cursor-grabbing"
      >
        <GripVertical
          size={13}
          strokeWidth={1.75}
          className="ml-1 shrink-0 text-[var(--ed-text-faint)] opacity-0 transition-opacity group-hover:opacity-100"
        />
        {hasSelection ? (
          <div className="min-w-0 flex-1">
            <SelectionSummary />
          </div>
        ) : (
          <span className="flex-1 px-2.5 py-3.5 text-[13px] font-semibold text-[var(--ed-text)]">
            {MODE_LABEL[mode]}
          </span>
        )}
      </div>

      {/* Tabs partition the *selection's* properties, so with nothing selected
          they'd offer three views of the same page-level controls. */}
      {hasSelection && <InspectorTabs />}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {hasSelection ? (
          <InspectorSections mode={mode} />
        ) : (
          <InspectorEmpty mode={mode} />
        )}
      </div>
    </aside>
  );
}
