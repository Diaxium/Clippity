import { Eye, EyeOff, Minus, Plus } from "lucide-react";

import { cn } from "@shared/lib/cn";
import { Select } from "@shared/ui";

import { useSelection, selectionIds } from "../../hooks/useSelection";
import {
  entriesAt,
  refsOf,
  sharedEntry,
  toggleTarget,
  triState,
  type EntryPeer,
} from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import type { StrokeAlign } from "../../types";
import { SELECT_TRIGGER_FULL } from "../fields/chrome";
import { ColorField } from "../fields/ColorField";
import { NumberField } from "../fields/NumberField";
import { PanelSection } from "./section";

const ALIGN_OPTIONS = [
  { value: "inside", label: "Inside" },
  { value: "center", label: "Center" },
  { value: "outside", label: "Outside" },
] as const;

const MIXED_ALIGN = { value: "__mixed", label: "Mixed" } as const;

/**
 * Strokes of the primary selection: color + opacity per stroke, plus width
 * and alignment.
 *
 * Multi-select is **edit-by-index** (Fork P-F1): the rows come from the primary,
 * and editing row *i* writes to entry *i* of every selected node that has one.
 * Selecting three outlined shapes and dragging the first stroke's width thickens
 * all three; a node with fewer strokes is skipped rather than having rows
 * invented for it.
 */
export function StrokeSection() {
  const addStrokes = useEditorStore((s) => s.addStrokes);
  const updateStrokes = useEditorStore((s) => s.updateStrokes);
  const removeStrokes = useEditorStore((s) => s.removeStrokes);
  const openColorEditor = useEditorStore((s) => s.openColorEditor);
  const setSectionOpen = useEditorStore((s) => s.setSectionOpen);

  const sel = useSelection();
  const node = sel[0];
  if (!node) return null;
  const ids = selectionIds(sel);

  return (
    <PanelSection
      id="stroke"
      title="Stroke"
      count={node.strokes.length}
      action={
        <button
          type="button"
          title="Add stroke"
          aria-label="Add stroke"
          onClick={() => {
            setSectionOpen("stroke", true);
            addStrokes(ids);
          }}
          className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      }
    >
      <div className="flex flex-col gap-2.5">
        {node.strokes.map((stroke, index) => {
          const peers = entriesAt(sel, "strokes", index);
          const refs = refsOf(peers);
          const color = sharedEntry(peers, (s) => s.color)!;
          const opacity = sharedEntry(peers, (s) => s.opacity)!;
          const width = sharedEntry(peers, (s) => s.width)!;
          const align = sharedEntry(peers, (s) => s.align)!;
          const visible = triState(
            peers,
            (p: EntryPeer<"strokes">) => p.entry.visible
          );
          return (
            <div key={stroke.id} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <ColorField
                    value={color.value}
                    mixed={color.mixed}
                    onChange={(v) => updateStrokes(refs, { color: v })}
                    onOpenEditor={(a) =>
                      openColorEditor(
                        {
                          kind: "stroke",
                          nodeId: node.id,
                          strokeId: stroke.id,
                        },
                        a.x,
                        a.y,
                        peers.slice(1).map((p) => ({
                          kind: "stroke" as const,
                          nodeId: p.nodeId,
                          strokeId: p.entry.id,
                        }))
                      )
                    }
                  />
                </div>
                <div className="w-[68px] shrink-0">
                  <NumberField
                    suffix="%"
                    min={0}
                    max={100}
                    value={Math.round(opacity.value * 100)}
                    mixed={opacity.mixed}
                    onChange={(v) => updateStrokes(refs, { opacity: v / 100 })}
                  />
                </div>
                <button
                  type="button"
                  title={visible === "on" ? "Hide stroke" : "Show stroke"}
                  aria-label={visible === "on" ? "Hide stroke" : "Show stroke"}
                  onClick={() =>
                    updateStrokes(refs, { visible: toggleTarget(visible) })
                  }
                  className={cn(
                    "flex h-8 w-7 shrink-0 items-center justify-center rounded-[6px]",
                    "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
                  )}
                >
                  {visible === "on" ? (
                    <Eye size={14} strokeWidth={1.75} />
                  ) : (
                    <EyeOff size={14} strokeWidth={1.75} />
                  )}
                </button>
                <button
                  type="button"
                  title="Remove stroke"
                  aria-label="Remove stroke"
                  onClick={() => removeStrokes(refs)}
                  className="flex h-8 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-danger)]"
                >
                  <Minus size={14} strokeWidth={2} />
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <Select
                    ariaLabel="Stroke alignment"
                    // A disagreeing selection shows a "Mixed" entry rather than
                    // claiming the primary's alignment; picking any real option
                    // unifies the rows.
                    value={align.mixed ? MIXED_ALIGN.value : align.value}
                    options={
                      align.mixed
                        ? [MIXED_ALIGN, ...ALIGN_OPTIONS]
                        : ALIGN_OPTIONS
                    }
                    onChange={(v) =>
                      v !== MIXED_ALIGN.value &&
                      updateStrokes(refs, { align: v as StrokeAlign })
                    }
                    triggerClassName={SELECT_TRIGGER_FULL}
                  />
                </div>
                <div className="w-[68px] shrink-0">
                  <NumberField
                    min={0}
                    value={width.value}
                    mixed={width.mixed}
                    onChange={(v) => updateStrokes(refs, { width: v })}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PanelSection>
  );
}
