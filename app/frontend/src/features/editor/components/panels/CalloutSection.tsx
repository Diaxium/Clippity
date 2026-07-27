import { useSelection } from "../../hooks/useSelection";
import { sharedWhere } from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

const SUB = FIELD_LABEL;

/**
 * Tail controls for a speech-bubble callout: the direction the tail points
 * (angle, 0° = up — scrub the field to swing it around the bubble) and how far
 * the tip extends past the body (length). Both can also be set by dragging the
 * tail's tip handle on the canvas (EditorCanvas's `tail` gesture). Shown in both
 * editor modes whenever the selection contains a callout.
 *
 * Multi-select (P3) swings every selected callout's tail together; non-callouts
 * caught in the same marquee sit out. The write goes through `updateEach`
 * because each callout has to keep the *rest* of its own spec — a shared patch
 * would stamp the primary's angle *and* length onto all of them.
 */
export function CalloutSection() {
  const updateEach = useEditorStore((s) => s.updateEach);

  const sel = useSelection();
  const callouts = sel.filter((n) => n.callout);
  const ids = callouts.map((n) => n.id);
  const angle = sharedWhere(callouts, (n) => n.callout?.angle);
  const length = sharedWhere(callouts, (n) => n.callout?.length);
  if (!angle || !length) return null;

  const setTail = (patch: { angle?: number; length?: number }) =>
    updateEach(ids, (n) =>
      n.callout ? { callout: { ...n.callout, ...patch } } : null
    );

  return (
    <PanelSection id="callout" title="Callout">
      <div className="flex gap-2">
        <div className="flex-1">
          <p className={SUB}>Tail angle</p>
          <NumberField
            suffix="°"
            step={1}
            value={angle.value}
            mixed={angle.mixed}
            onChange={(v) => setTail({ angle: v })}
          />
        </div>
        <div className="flex-1">
          <p className={SUB}>Tail length</p>
          <NumberField
            suffix="px"
            min={0}
            step={1}
            value={length.value}
            mixed={length.mixed}
            onChange={(v) => setTail({ length: v })}
          />
        </div>
      </div>
    </PanelSection>
  );
}
