import { useCapabilities } from "@state/useCapabilities";

import { useCaptureStore } from "../state/captureStore";
import {
  CUSTOM_MODES_ADVANCED,
  CUSTOM_MODES_STANDARD,
  isCustomModeInstalled,
} from "../modes";
import { CollapsibleSection } from "./CollapsibleSection";
import { ModeTile } from "./ModeTile";

interface CustomModesPanelProps {
  startIndex?: number;
}

/**
 * The Standard + Advanced custom-modes panel. Visible only when the
 * top-level Capture Type is `custom`. Every tile is disabled in MVP
 * — the catalogue is shown so the user sees the full product shape,
 * with `unavailableHint` tooltips pointing at the responsible later
 * ports.
 *
 * A tile is also disabled when its component was declined at install time
 * (Grab Text without the OCR engine); it stays in the grid, badged "Not
 * installed", for the same reason the unshipped tiles do — the catalogue is
 * the product shape, and this one the user can get back through the
 * installer's Modify flow.
 */
export function CustomModesPanel({ startIndex = 2 }: CustomModesPanelProps) {
  const customMode = useCaptureStore((s) => s.customMode);
  const setCustomMode = useCaptureStore((s) => s.setCustomMode);
  const capabilities = useCapabilities();

  return (
    <CollapsibleSection n={startIndex} title="Custom Modes">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {CUSTOM_MODES_STANDARD.map((def) => (
          <ModeTile
            key={def.id}
            def={def}
            active={customMode === def.id}
            notInstalled={!isCustomModeInstalled(def.id, capabilities)}
            onSelect={setCustomMode}
          />
        ))}
      </div>

      <div className="mt-4 mb-2 flex items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
          Advanced
        </span>
        <span className="h-px flex-1 bg-[color:var(--hairline)]" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {CUSTOM_MODES_ADVANCED.map((def) => (
          <ModeTile
            key={def.id}
            def={def}
            active={customMode === def.id}
            notInstalled={!isCustomModeInstalled(def.id, capabilities)}
            onSelect={setCustomMode}
          />
        ))}
      </div>
    </CollapsibleSection>
  );
}
