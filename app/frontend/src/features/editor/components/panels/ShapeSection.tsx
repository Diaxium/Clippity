import { type ReactNode } from "react";

import { useSelection } from "../../hooks/useSelection";
import { shared, toggleTarget, triState } from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

const SUB = FIELD_LABEL;

/**
 * Geometry parameters that define polygon / star / path shapes, editable after
 * creation: polygon sides, star point count + inner ratio, path closed. Both
 * renderers already read these fields, so edits update live + on export.
 *
 * Multi-select (P3) groups by **shape type** — the parameters aren't shared
 * across types (a star's point count is not a polygon's side count), so the
 * panel follows the primary's type and edits every selected shape of that type.
 * Renders nothing when the primary isn't one of the three.
 */
export function ShapeSection() {
  const updateNodes = useEditorStore((s) => s.updateNodes);

  const sel = useSelection();
  const node = sel[0];
  if (!node) return null;

  if (node.type === "polygon") {
    const peers = sel.filter((n) => n.type === "polygon");
    const ids = peers.map((n) => n.id);
    const sides = shared(peers, (n) => n.sides)!;
    return (
      <Wrap title="Polygon">
        <p className={SUB}>Count</p>
        <NumberField
          min={3}
          value={sides.value}
          mixed={sides.mixed}
          onChange={(v) => updateNodes(ids, { sides: Math.max(3, Math.round(v)) })}
        />
      </Wrap>
    );
  }

  if (node.type === "star") {
    const peers = sel.filter((n) => n.type === "star");
    const ids = peers.map((n) => n.id);
    const pointCount = shared(peers, (n) => n.pointCount)!;
    const innerRatio = shared(peers, (n) => n.innerRatio)!;
    return (
      <Wrap title="Star">
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <p className={SUB}>Count</p>
            <NumberField
              min={3}
              value={pointCount.value}
              mixed={pointCount.mixed}
              onChange={(v) =>
                updateNodes(ids, { pointCount: Math.max(3, Math.round(v)) })
              }
            />
          </div>
          <div>
            <p className={SUB}>Ratio</p>
            <NumberField
              suffix="%"
              min={1}
              max={100}
              value={Math.round(innerRatio.value * 100)}
              mixed={innerRatio.mixed}
              onChange={(v) =>
                updateNodes(ids, {
                  innerRatio: Math.min(1, Math.max(0.01, v / 100)),
                })
              }
            />
          </div>
        </div>
      </Wrap>
    );
  }

  if (node.type === "path") {
    const peers = sel.filter((n) => n.type === "path");
    const ids = peers.map((n) => n.id);
    const closed = triState(peers, (n) => n.closed);
    return (
      <Wrap title="Path">
        <label className="flex items-center gap-2 text-[12px] text-[var(--ed-text)]">
          <input
            type="checkbox"
            checked={closed === "on"}
            ref={(el) => {
              if (el) el.indeterminate = closed === "mixed";
            }}
            onChange={() => updateNodes(ids, { closed: toggleTarget(closed) })}
            className="accent-[var(--ed-accent)]"
          />
          Closed
        </label>
      </Wrap>
    );
  }

  return null;
}

function Wrap({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PanelSection id="shape" title={title}>
      {children}
    </PanelSection>
  );
}
