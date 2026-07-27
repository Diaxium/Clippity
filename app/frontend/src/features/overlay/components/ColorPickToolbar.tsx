import { X } from "lucide-react";

import { cancelRegionCapture } from "@services/tauri/clients/overlay";

import { CHROME_STOP_PROPS } from "../eventStops";
import { useOverlayStore } from "../state/overlayStore";

/**
 * Minimal bottom chrome for Color-Picker mode. Color-Pick has no
 * selection and no Capture action — one click samples the pixel — so the
 * full `BottomToolbar` (mode tabs / Capture CTA / utility toggles)
 * doesn't apply. This is just a hint pill + a Cancel button.
 */
export function ColorPickToolbar() {
  const reset = useOverlayStore((s) => s.reset);

  const onCancel = () => {
    reset();
    void cancelRegionCapture();
  };

  return (
    <div
      {...CHROME_STOP_PROPS}
      className="absolute bottom-6 left-1/2 z-20 -translate-x-1/2"
    >
      <div className="flex items-center gap-2 rounded-[14px] border border-[color:var(--hairline)] bg-[var(--color-surface)]/85 px-3 py-1.5 shadow-[var(--shadow-medium)] backdrop-blur-[10px]">
        <span className="text-[12px] font-medium text-[var(--color-slate)]">
          Click any pixel to copy its color
        </span>
        <span className="h-5 w-px bg-[color:var(--color-overlay-2)]" />
        <button
          type="button"
          onClick={onCancel}
          className="grid h-7 w-7 place-items-center rounded-[10px] text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
          aria-label="Cancel"
          title="Cancel (Esc)"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
