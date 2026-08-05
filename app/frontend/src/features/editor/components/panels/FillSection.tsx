import { Eye, EyeOff, Minus, Plus } from "lucide-react";

import { useSelection, selectionIds } from "../../hooks/useSelection";
import {
  entriesAt,
  MIXED_LABEL,
  refsOf,
  sharedEntry,
  toggleTarget,
  triState,
  type EntryPeer,
} from "../../lib/multi";
import { paintPreviewCss } from "../../lib/paint";
import { useEditorStore } from "../../state/editorStore";
import { NumberField } from "../fields/NumberField";
import { PanelSection } from "./section";

/**
 * Fills of the primary selection. Each row's swatch opens the floating color
 * editor (FE1); the row carries opacity, visibility, and remove.
 *
 * Multi-select is **edit-by-index** (Fork P-F1) — see `StrokeSection` for the
 * rationale. The swatch hands the popover the peer rows so a color or gradient
 * edit paints the whole selection, not just the primary.
 */
export function FillSection() {
  const addFills = useEditorStore((s) => s.addFills);
  const updateFills = useEditorStore((s) => s.updateFills);
  const removeFills = useEditorStore((s) => s.removeFills);
  const colorEditor = useEditorStore((s) => s.colorEditor);
  const openColorEditor = useEditorStore((s) => s.openColorEditor);
  const closeColorEditor = useEditorStore((s) => s.closeColorEditor);

  const sel = useSelection();

  const node = sel[0];
  if (!node) return null;
  const id = node.id;
  const ids = selectionIds(sel);

  const editingFill = (fillId: string): boolean =>
    colorEditor?.target.kind === "fill" && colorEditor.target.fillId === fillId;

  return (
    <PanelSection
      id="fill"
      title="Fill"
      action={
        <button
          type="button"
          title="Add fill"
          aria-label="Add fill"
          onClick={() => addFills(ids)}
          className="flex h-5 w-5 items-center justify-center rounded-[4px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      }
    >
      <div className="flex flex-col gap-1.5">
        {node.fills.map((fill, index) => {
          const peers = entriesAt(sel, "fills", index);
          const refs = refsOf(peers);
          const opacity = sharedEntry(peers, (f) => f.opacity)!;
          const visible = triState(
            peers,
            (p: EntryPeer<"fills">) => p.entry.visible
          );
          // The swatch previews one paint, so it can only speak for the row when
          // the selection agrees on what that paint *looks like*.
          const paint = sharedEntry(
            peers,
            (f) => f,
            (f) => paintPreviewCss(f)
          )!;
          const label = paint.mixed
            ? MIXED_LABEL
            : fill.type === "gradient"
              ? fill.gradient?.kind === "radial"
                ? "Radial"
                : fill.gradient?.kind === "freeform"
                  ? "Freeform"
                  : fill.gradient?.kind === "mesh"
                    ? "Mesh"
                    : "Linear"
              : fill.type === "image"
                ? "Image"
                : fill.color.replace(/^#/, "").toUpperCase();
          return (
            <div key={fill.id} className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Edit fill"
                aria-expanded={editingFill(fill.id)}
                onClick={(e) => {
                  if (editingFill(fill.id)) {
                    closeColorEditor();
                    return;
                  }
                  const r = e.currentTarget.getBoundingClientRect();
                  openColorEditor(
                    { kind: "fill", nodeId: id, fillId: fill.id },
                    r.left,
                    r.top,
                    peers.slice(1).map((p) => ({
                      kind: "fill" as const,
                      nodeId: p.nodeId,
                      fillId: p.entry.id,
                    }))
                  );
                }}
                className={
                  // Sized to the shared control chrome (see fields/chrome.ts)
                  // so it lines up with the opacity field beside it.
                  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-[color:var(--ed-control-hairline)] bg-[var(--ed-input-bg)] px-2 hover:bg-[var(--ed-input-bg-hover)] " +
                  (editingFill(fill.id) ? "ring-1 ring-[var(--ed-accent)]" : "")
                }
              >
                {paint.mixed ? (
                  <span
                    className="h-4 w-4 shrink-0 rounded-[3px] border border-[color:var(--ed-hairline)]"
                    style={{
                      background:
                        "linear-gradient(135deg, var(--ed-elev) 45%, var(--ed-text-faint) 45%, var(--ed-text-faint) 55%, var(--ed-elev) 55%)",
                    }}
                  />
                ) : fill.type === "image" && fill.src ? (
                  <img
                    src={fill.src}
                    alt=""
                    className="h-4 w-4 shrink-0 rounded-[3px] object-cover"
                  />
                ) : (
                  <span
                    className="h-4 w-4 shrink-0 rounded-[3px] border border-[color:var(--ed-hairline)]"
                    style={{ background: paintPreviewCss(fill) }}
                  />
                )}
                <span className="truncate text-[12px] text-[var(--ed-text)]">
                  {label}
                </span>
              </button>
              <div className="w-[68px] shrink-0">
                <NumberField
                  suffix="%"
                  min={0}
                  max={100}
                  value={Math.round(opacity.value * 100)}
                  mixed={opacity.mixed}
                  onChange={(v) => updateFills(refs, { opacity: v / 100 })}
                />
              </div>
              <button
                type="button"
                title={visible === "on" ? "Hide fill" : "Show fill"}
                aria-label={visible === "on" ? "Hide fill" : "Show fill"}
                onClick={() =>
                  updateFills(refs, { visible: toggleTarget(visible) })
                }
                className="flex h-8 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
              >
                {visible === "on" ? (
                  <Eye size={14} strokeWidth={1.75} />
                ) : (
                  <EyeOff size={14} strokeWidth={1.75} />
                )}
              </button>
              <button
                type="button"
                title="Remove fill"
                aria-label="Remove fill"
                onClick={() => {
                  if (editingFill(fill.id)) closeColorEditor();
                  removeFills(refs);
                }}
                className="flex h-8 w-7 shrink-0 items-center justify-center rounded-[6px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-danger)]"
              >
                <Minus size={14} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>
    </PanelSection>
  );
}
