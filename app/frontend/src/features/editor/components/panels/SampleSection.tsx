import { useSelection } from "../../hooks/useSelection";
import { sharedWhere } from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import { SAMPLE_CFG } from "./sampleConfig";
import { FIELD_LABEL, PanelSection } from "./section";
import { NumberField } from "../fields/NumberField";

const SUB = FIELD_LABEL;

/**
 * Amount control for the Blur / Pixelate / Magnifier "sample" regions: blur
 * radius (px), pixelate cell size (px), or magnifier zoom (×). The dedicated
 * Annotate-mode panel; in Design mode the same sample surfaces as an Effects row
 * (see ADR 0015).
 *
 * Multi-select (P3) adjusts every sample of the **same mode** at once — the
 * common "I blurred four things, now soften them all" edit. Modes are grouped
 * because the amount means a different quantity in each (px radius vs cell size
 * vs zoom factor), so a shared field across modes would be meaningless; the
 * panel follows the primary's mode and the other modes sit out.
 */
export function SampleSection() {
  const updateEach = useEditorStore((s) => s.updateEach);

  const sel = useSelection();
  const mode = sel.find((n) => n.sample)?.sample?.mode;
  const peers = sel.filter((n) => n.sample?.mode === mode);
  const amount = sharedWhere(peers, (n) => n.sample?.amount);
  if (!mode || !amount) return null;
  const ids = peers.map((n) => n.id);
  const cfg = SAMPLE_CFG[mode];

  return (
    <PanelSection id="sample" title={cfg.title}>
      <p className={SUB}>{cfg.label}</p>
      <div className="w-24">
        <NumberField
          suffix={cfg.suffix}
          min={cfg.min}
          step={cfg.step}
          value={amount.value}
          mixed={amount.mixed}
          onChange={(v) =>
            updateEach(ids, (n) =>
              n.sample ? { sample: { ...n.sample, amount: v } } : null
            )
          }
        />
      </div>
    </PanelSection>
  );
}
