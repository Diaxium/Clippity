import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@shared/lib/cn";
import { Select } from "@shared/ui";

import { useSelection } from "../../hooks/useSelection";
import { sharedWhere } from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import type { TextAlign } from "../../types";
import { SELECT_TRIGGER_FULL } from "../fields/chrome";
import { ColorField } from "../fields/ColorField";
import { NumberField } from "../fields/NumberField";
import { FIELD_LABEL, PanelSection } from "./section";

const SUB = FIELD_LABEL;
const TRIGGER = SELECT_TRIGGER_FULL;

// Standard CSS weights. Font *family* is fixed to Inter for now (roadmap Phase 3).
const WEIGHTS = [
  { value: "100", label: "Thin" },
  { value: "200", label: "Extra Light" },
  { value: "300", label: "Light" },
  { value: "400", label: "Regular" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
  { value: "800", label: "Extrabold" },
  { value: "900", label: "Black" },
] as const;

const MIXED_WEIGHT = { value: "__mixed", label: "Mixed" } as const;

const ALIGNS: readonly { value: TextAlign; Icon: LucideIcon; label: string }[] =
  [
    { value: "left", Icon: AlignLeft, label: "Align left" },
    { value: "center", Icon: AlignCenter, label: "Align center" },
    { value: "right", Icon: AlignRight, label: "Align right" },
  ];

/**
 * Text properties: size, weight, line height, letter spacing, alignment, and
 * color (which lives on `node.color`, separate from fills — that's what the
 * renderers read).
 *
 * Multi-select (P3) reads through `sharedWhere`, so the section appears whenever
 * the selection contains *any* text node and writes to just those. Restyling
 * five labels at once is the point; a rectangle caught in the marquee sits out
 * rather than hiding the section or reading as a disagreement.
 */
export function TextSection() {
  const updateNodes = useEditorStore((s) => s.updateNodes);
  const openColorEditor = useEditorStore((s) => s.openColorEditor);

  const sel = useSelection();

  const texts = sel.filter((n) => n.type === "text");
  const primary = texts[0];
  if (!primary) return null;
  const ids = texts.map((n) => n.id);

  const pick = <T,>(f: (n: (typeof texts)[number]) => T) =>
    sharedWhere(texts, f)!;
  const fontSize = pick((n) => n.fontSize);
  const fontWeight = pick((n) => n.fontWeight);
  const lineHeight = pick((n) => n.lineHeight);
  const letterSpacing = pick((n) => n.letterSpacing);
  const align = pick((n) => n.align);
  const color = pick((n) => n.color);

  return (
    <PanelSection id="text" title="Text">
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <p className={SUB}>Size</p>
          <NumberField
            min={1}
            value={fontSize.value}
            mixed={fontSize.mixed}
            onChange={(v) => updateNodes(ids, { fontSize: v })}
          />
        </div>
        <div>
          <p className={SUB}>Weight</p>
          <Select
            ariaLabel="Font weight"
            // A disagreeing selection shows a "Mixed" entry rather than
            // claiming the primary's weight; picking a real one unifies them.
            value={
              fontWeight.mixed ? MIXED_WEIGHT.value : String(fontWeight.value)
            }
            options={fontWeight.mixed ? [MIXED_WEIGHT, ...WEIGHTS] : WEIGHTS}
            onChange={(v) =>
              v !== MIXED_WEIGHT.value &&
              updateNodes(ids, { fontWeight: Number(v) })
            }
            triggerClassName={TRIGGER}
          />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <div>
          <p className={SUB}>Line height</p>
          <NumberField
            min={0}
            step={0.1}
            value={lineHeight.value}
            mixed={lineHeight.mixed}
            onChange={(v) => updateNodes(ids, { lineHeight: v })}
          />
        </div>
        <div>
          <p className={SUB}>Letter spacing</p>
          <NumberField
            value={letterSpacing.value}
            mixed={letterSpacing.mixed}
            onChange={(v) => updateNodes(ids, { letterSpacing: v })}
          />
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <div>
          <p className={SUB}>Align</p>
          <div className="flex rounded-[6px] bg-[var(--ed-input-bg)] p-0.5">
            {ALIGNS.map(({ value, Icon, label }) => (
              <button
                key={value}
                type="button"
                title={label}
                aria-label={label}
                // A mixed selection leaves every button unpressed, so nothing
                // claims an alignment half the text nodes don't have.
                aria-pressed={!align.mixed && align.value === value}
                onClick={() => updateNodes(ids, { align: value })}
                className={cn(
                  "flex h-6 flex-1 items-center justify-center rounded-[5px]",
                  !align.mixed && align.value === value
                    ? "bg-[var(--ed-accent-soft)] text-[var(--ed-accent)]"
                    : "text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
                )}
              >
                <Icon size={14} strokeWidth={1.75} />
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className={SUB}>Color</p>
          <ColorField
            value={color.value}
            mixed={color.mixed}
            onChange={(v) => updateNodes(ids, { color: v })}
            onOpenEditor={(a) =>
              openColorEditor(
                { kind: "text", nodeId: primary.id },
                a.x,
                a.y,
                texts.slice(1).map((n) => ({
                  kind: "text" as const,
                  nodeId: n.id,
                }))
              )
            }
          />
        </div>
      </div>
    </PanelSection>
  );
}
