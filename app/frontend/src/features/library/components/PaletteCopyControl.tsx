import { useState } from "react";

import { Check, Copy } from "lucide-react";

import {
  PALETTE_FORMATS,
  formatPalette,
  type PaletteFormat,
} from "@shared/lib/paletteExport";

import type { AuxColor } from "../types";

/**
 * Compact "Copy as <format>" control for a palette library entry — a
 * format selector + a copy button that writes the whole palette in the
 * chosen format (HEX / RGB / HSL / CSS vars / JSON / Tailwind). Lives in
 * the card/row action cluster, replacing the single copy icon the other
 * aux kinds use. Per-swatch single-hex copy stays on the swatches
 * themselves (`PalettePreview`).
 */
export function PaletteCopyControl({ palette }: { palette: AuxColor[] }) {
  const [format, setFormat] = useState<PaletteFormat>("hex-list");
  const [done, setDone] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(formatPalette(palette, format));
    setDone(true);
    window.setTimeout(() => setDone(false), 1100);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <select
        value={format}
        onChange={(e) => setFormat(e.currentTarget.value as PaletteFormat)}
        aria-label="Copy format"
        className="focus-ring rounded-md border border-[color:var(--hairline)] bg-[var(--color-surface)] px-1.5 py-1 text-[11px] font-medium text-[var(--color-slate)] outline-none"
      >
        {PALETTE_FORMATS.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label={done ? "Palette copied" : "Copy palette"}
        title={done ? "Copied" : "Copy palette"}
        onClick={copy}
        className="focus-ring grid h-7 w-7 place-items-center rounded-md text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
      >
        {done ? (
          <Check size={14} strokeWidth={1.85} />
        ) : (
          <Copy size={14} strokeWidth={1.85} />
        )}
      </button>
    </span>
  );
}
