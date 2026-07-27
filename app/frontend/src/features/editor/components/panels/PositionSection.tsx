import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  FlipHorizontal2,
  FlipVertical2,
  RotateCw,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@shared/lib/cn";

import { useSelection, selectionIds } from "../../hooks/useSelection";
import { shared, toggleTarget, triState } from "../../lib/multi";
import { useEditorStore, type AlignMode } from "../../state/editorStore";
import { nodeBounds } from "../../types";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

interface AlignBtn {
  mode: AlignMode;
  Icon: LucideIcon;
  label: string;
}

const ALIGN_H: readonly AlignBtn[] = [
  { mode: "left", Icon: AlignStartVertical, label: "Align left" },
  {
    mode: "center-h",
    Icon: AlignCenterVertical,
    label: "Align horizontal centers",
  },
  { mode: "right", Icon: AlignEndVertical, label: "Align right" },
];
const ALIGN_V: readonly AlignBtn[] = [
  { mode: "top", Icon: AlignStartHorizontal, label: "Align top" },
  {
    mode: "center-v",
    Icon: AlignCenterHorizontal,
    label: "Align vertical centers",
  },
  { mode: "bottom", Icon: AlignEndHorizontal, label: "Align bottom" },
];
const DISTRIBUTE: readonly AlignBtn[] = [
  {
    mode: "distribute-h",
    Icon: AlignHorizontalSpaceAround,
    label: "Distribute horizontally",
  },
  {
    mode: "distribute-v",
    Icon: AlignVerticalSpaceAround,
    label: "Distribute vertically",
  },
];

const ICON_BTN =
  "flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]";

/**
 * Position block: alignment clusters, X/Y, and rotation with flip controls.
 *
 * Multi-select (P3) edits the whole selection: X/Y read "Mixed" when the
 * selection disagrees and typing one **aligns** every node to that coordinate,
 * which is the useful reading of "set X to 40" for a batch. The write goes
 * through `placeNodes`, not a raw `x` patch, because nodes hold absolute
 * coordinates — patching a frame's `x` would slide it out from under its own
 * children.
 */
export function PositionSection() {
  const updateNodes = useEditorStore((s) => s.updateNodes);
  const placeNodes = useEditorStore((s) => s.placeNodes);
  const align = useEditorStore((s) => s.align);

  const sel = useSelection();

  const node = sel[0];
  if (!node) return null;
  const ids = selectionIds(sel);
  const canDistribute = sel.length >= 3;

  // Bounds, not raw x/y: a rotated or line-like node's coordinate is its
  // bounding box's, which is what `placeNodes` moves to and what the canvas
  // shows — reading `node.x` here would disagree with both.
  const x = shared(sel, (n) => nodeBounds(n).x)!;
  const y = shared(sel, (n) => nodeBounds(n).y)!;
  const rotation = shared(sel, (n) => n.rotation)!;
  const flipH = triState(sel, (n) => n.flipH);
  const flipV = triState(sel, (n) => n.flipV);

  return (
    <PanelSection id="position" title="Position">

      <p className={FIELD_LABEL}>Alignment</p>
      <div className="mb-2.5 flex items-center gap-1">
        <div className="flex rounded-[6px] bg-[var(--ed-input-bg)]">
          {ALIGN_H.map(({ mode, Icon, label }) => (
            <button
              key={mode}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => align(mode)}
              className={ICON_BTN}
            >
              <Icon size={15} strokeWidth={1.75} />
            </button>
          ))}
        </div>
        <div className="flex rounded-[6px] bg-[var(--ed-input-bg)]">
          {ALIGN_V.map(({ mode, Icon, label }) => (
            <button
              key={mode}
              type="button"
              title={label}
              aria-label={label}
              onClick={() => align(mode)}
              className={ICON_BTN}
            >
              <Icon size={15} strokeWidth={1.75} />
            </button>
          ))}
        </div>
        <div className="flex rounded-[6px] bg-[var(--ed-input-bg)]">
          {DISTRIBUTE.map(({ mode, Icon, label }) => (
            <button
              key={mode}
              type="button"
              title={label}
              aria-label={label}
              disabled={!canDistribute}
              onClick={canDistribute ? () => align(mode) : undefined}
              className={cn(ICON_BTN, !canDistribute && "opacity-40")}
            >
              <Icon size={15} strokeWidth={1.75} />
            </button>
          ))}
        </div>
      </div>

      <p className={FIELD_LABEL}>Position</p>
      <div className="mb-2.5 grid grid-cols-2 gap-1.5">
        <NumberField
          label="X"
          value={x.value}
          mixed={x.mixed}
          onChange={(v) => placeNodes(ids, { x: v })}
        />
        <NumberField
          label="Y"
          value={y.value}
          mixed={y.mixed}
          onChange={(v) => placeNodes(ids, { y: v })}
        />
      </div>

      <p className={FIELD_LABEL}>Rotation</p>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <NumberField
            icon={<RotateCw size={13} strokeWidth={1.75} />}
            suffix="°"
            value={rotation.value}
            mixed={rotation.mixed}
            onChange={(v) => updateNodes(ids, { rotation: v })}
          />
        </div>
        <button
          type="button"
          title="Flip horizontal"
          aria-label="Flip horizontal"
          aria-pressed={flipH === "on"}
          onClick={() => updateNodes(ids, { flipH: toggleTarget(flipH) })}
          className={cn(
            ICON_BTN,
            flipH === "on" && "bg-[var(--ed-accent-soft)] text-[var(--ed-accent)]"
          )}
        >
          <FlipHorizontal2 size={15} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Flip vertical"
          aria-label="Flip vertical"
          aria-pressed={flipV === "on"}
          onClick={() => updateNodes(ids, { flipV: toggleTarget(flipV) })}
          className={cn(
            ICON_BTN,
            flipV === "on" && "bg-[var(--ed-accent-soft)] text-[var(--ed-accent)]"
          )}
        >
          <FlipVertical2 size={15} strokeWidth={1.75} />
        </button>
      </div>
    </PanelSection>
  );
}
