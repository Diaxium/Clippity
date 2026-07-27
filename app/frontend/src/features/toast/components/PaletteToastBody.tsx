import { useState } from "react";

import { Check, Copy } from "lucide-react";

import {
  PALETTE_FORMATS,
  formatPalette,
  type PaletteFormat,
} from "@shared/lib/paletteExport";

import type { PaletteSwatch } from "../types";

/**
 * Palette-Capture toast body — the source-region preview, a strip of
 * extracted swatches (sized by each color's share of the region and
 * labelled with its hex + percentage), and a "Copy as" bar that exports
 * the whole palette in a chosen format. Clicking a single swatch copies
 * just its hex. Swatch fills are runtime data (quantized colors), so
 * they're inline styles.
 */
export function PaletteToastBody({
  preview,
  colors,
}: {
  preview: string;
  colors: PaletteSwatch[];
}) {
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const [format, setFormat] = useState<PaletteFormat>("hex-list");
  const [copiedAll, setCopiedAll] = useState(false);

  const copyHex = (hex: string) => {
    void navigator.clipboard?.writeText(hex);
    setCopiedHex(hex);
    window.setTimeout(
      () => setCopiedHex((cur) => (cur === hex ? null : cur)),
      1100
    );
  };

  const copyAll = () => {
    void navigator.clipboard?.writeText(formatPalette(colors, format));
    setCopiedAll(true);
    window.setTimeout(() => setCopiedAll(false), 1100);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3.5 pr-14">
        {preview ? (
          <img
            src={preview}
            alt="Palette source"
            className="h-12 w-12 shrink-0 rounded-[10px] border border-[color:var(--hairline)] object-cover"
            draggable={false}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
            Palette extracted
          </span>
          <div className="flex items-stretch gap-1">
            {colors.map((c, i) => (
              <button
                key={`${c.hex}:${i}`}
                type="button"
                onClick={() => copyHex(c.hex)}
                title={`Copy ${c.hex}${
                  c.proportion != null
                    ? ` · ${Math.round(c.proportion * 100)}%`
                    : ""
                }`}
                aria-label={`Copy ${c.hex}`}
                style={{ flexGrow: c.proportion ?? 1, flexBasis: 0 }}
                className="focus-ring group/swatch flex min-w-[2rem] flex-col gap-1 rounded-md"
              >
                <span
                  className="h-9 w-full rounded-md border border-[color:var(--hairline)] transition-transform group-hover/swatch:scale-[1.04]"
                  style={{ backgroundColor: c.hex }}
                />
                <span className="truncate text-center font-mono text-[9.5px] font-medium text-[var(--color-ink)]">
                  {copiedHex === c.hex ? "Copied" : c.hex}
                </span>
                {c.proportion != null ? (
                  <span className="text-center text-[9px] text-[var(--color-hint)]">
                    {Math.round(c.proportion * 100)}%
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <label className="sr-only" htmlFor="palette-copy-format">
          Copy format
        </label>
        <select
          id="palette-copy-format"
          value={format}
          onChange={(e) => setFormat(e.currentTarget.value as PaletteFormat)}
          className="focus-ring rounded-md border border-[color:var(--hairline)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-medium text-[var(--color-ink)] outline-none"
        >
          {PALETTE_FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={copyAll}
          className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-[color:var(--hairline)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[color:var(--color-overlay-1)]"
        >
          {copiedAll ? (
            <Check size={12} strokeWidth={2} />
          ) : (
            <Copy size={12} strokeWidth={2} />
          )}
          {copiedAll ? "Copied" : "Copy all"}
        </button>
      </div>
    </div>
  );
}
