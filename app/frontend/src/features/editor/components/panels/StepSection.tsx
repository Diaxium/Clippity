import { useSelection } from "../../hooks/useSelection";
import { useEditorStore } from "../../state/editorStore";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

const SUB = FIELD_LABEL;

/**
 * Number control for a step badge. New badges auto-increment on creation, but
 * the value is editable here (e.g. to renumber after deleting one). Shown in
 * both editor modes.
 *
 * **The one field P3 deliberately does not batch.** A badge's number is its
 * identity within a sequence, not a shared style: applying one value across a
 * multi-selection would flatten 1·2·3 into 3·3·3, which is never the intent.
 * So the section shows only for a single badge — renumbering stays a
 * one-at-a-time edit rather than a field that silently destroys the sequence.
 */
export function StepSection() {
  const updateNode = useEditorStore((s) => s.updateNode);

  const sel = useSelection();
  const badges = sel.filter((n) => n.step);
  const node = badges.length === 1 ? badges[0] : undefined;
  const step = node?.step;
  if (!node || !step) return null;
  const id = node.id;

  return (
    <PanelSection id="step" title="Step">
      <p className={SUB}>Number</p>
      <div className="w-24">
        <NumberField
          min={1}
          step={1}
          value={step.number}
          onChange={(number) =>
            updateNode(id, { step: { ...step, number: Math.round(number) } })
          }
        />
      </div>
    </PanelSection>
  );
}
