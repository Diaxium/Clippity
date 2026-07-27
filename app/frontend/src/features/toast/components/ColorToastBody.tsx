import type { PickedColor } from "../types";

/**
 * Color-Pick toast body — a swatch of the sampled color plus its HEX +
 * RGB readout. Surfaced after the Color-Picker overlay mode copies the
 * hex to the clipboard.
 *
 * The swatch fill is runtime data (the sampled pixel), so it's an inline
 * style rather than a design token — the design-token rule governs
 * design-system values, not sampled content.
 */
export function ColorToastBody({ color }: { color: PickedColor }) {
  return (
    <div className="flex items-center gap-3.5 pr-14">
      <span
        aria-hidden
        className="h-12 w-12 shrink-0 rounded-[12px] border border-[color:var(--hairline)] shadow-[var(--shadow-subtle)]"
        style={{ backgroundColor: color.hex }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
          Color copied
        </span>
        <span className="font-mono text-[13.5px] font-semibold text-[var(--color-ink)]">
          {color.hex}
        </span>
        <span className="text-[11.5px] leading-snug text-[var(--color-slate)]">
          rgb({color.r}, {color.g}, {color.b})
        </span>
      </div>
    </div>
  );
}
