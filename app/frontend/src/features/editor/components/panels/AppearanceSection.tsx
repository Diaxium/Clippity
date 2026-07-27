import { Eye, EyeOff } from "lucide-react";

import { Select } from "@shared/ui";

import { useSelection, selectionIds } from "../../hooks/useSelection";
import { shared, toggleTarget, triState } from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";
import type { BlendMode } from "../../types";
import { SliderField } from "../fields/SliderField";
import { PanelSection, ROW_LABEL } from "./section";

const BLEND_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "color-dodge", label: "Color dodge" },
  { value: "color-burn", label: "Color burn" },
  { value: "hard-light", label: "Hard light" },
  { value: "soft-light", label: "Soft light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
] as const;

/**
 * How the node composites: opacity, blend mode, and visibility.
 *
 * Opacity is a slider with the percentage read out beside its label rather than
 * a number field — it's the one property here that's judged by eye against the
 * canvas, so it wants a control you can sweep. Corner radius used to share this
 * section and now has its own (see `CornersSection`).
 *
 * Multi-select (P3): everything here applies to the whole selection; a
 * disagreeing blend mode shows "Mixed" until a pick unifies it.
 */
export function AppearanceSection() {
  const updateNodes = useEditorStore((s) => s.updateNodes);

  const sel = useSelection();

  const node = sel[0];
  if (!node) return null;
  const ids = selectionIds(sel);

  const opacity = shared(sel, (n) => n.opacity)!;
  const visible = triState(sel, (n) => n.visible);
  // Absent blendMode is "normal" — normalized here so a mix of unset and
  // explicitly-normal nodes doesn't read as disagreement.
  const blend = shared(sel, (n) => n.blendMode ?? "normal")!;

  return (
    <PanelSection
      id="appearance"
      title="Appearance"
      action={
        <button
          type="button"
          title={visible === "on" ? "Hide" : "Show"}
          aria-label={visible === "on" ? "Hide" : "Show"}
          onClick={() => updateNodes(ids, { visible: toggleTarget(visible) })}
          className="flex h-6 w-6 items-center justify-center rounded-[5px] text-[var(--ed-text-dim)] hover:bg-[var(--ed-elev)] hover:text-[var(--ed-text)]"
        >
          {visible === "on" ? (
            <Eye size={14} strokeWidth={1.75} />
          ) : (
            <EyeOff size={14} strokeWidth={1.75} />
          )}
        </button>
      }
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className={ROW_LABEL}>Opacity</span>
        <span className="text-[12px] font-medium tabular-nums text-[var(--ed-text)]">
          {opacity.mixed ? "Mixed" : `${Math.round(opacity.value * 100)}%`}
        </span>
      </div>
      <SliderField
        ariaLabel="Opacity"
        min={0}
        max={100}
        value={Math.round(opacity.value * 100)}
        mixed={opacity.mixed}
        onChange={(v) => updateNodes(ids, { opacity: v / 100 })}
      />

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={ROW_LABEL}>Blend mode</span>
        <Select
          ariaLabel="Blend mode"
          value={blend.value}
          placeholder={blend.mixed ? "Mixed" : undefined}
          options={BLEND_OPTIONS}
          onChange={(v) => updateNodes(ids, { blendMode: v as BlendMode })}
          triggerClassName="h-8 w-[136px] rounded-[8px] border border-[color:var(--ed-control-hairline)] bg-[var(--ed-control-bg)] px-2.5 text-[12px] text-[var(--ed-text)]"
        />
      </div>
    </PanelSection>
  );
}
