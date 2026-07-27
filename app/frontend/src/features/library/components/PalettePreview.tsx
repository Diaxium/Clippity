import { useState } from "react";

import type { AuxColor } from "../types";

/**
 * Interactive palette strip for a grid card. Each swatch is its own
 * button — click to copy that color's hex (with brief "Copied"
 * feedback) — sized by the color's share of the region, with the hex +
 * percentage revealed on hover/focus. Unlike `AuxPreview` (which renders
 * non-interactive swatches inside the card's copy-all button), this is
 * rendered standalone so the per-swatch buttons aren't nested in another
 * button. Copy-the-whole-palette stays available from the card actions.
 *
 * Swatch fills are runtime data (quantized colors), so they're inline
 * styles, not design tokens.
 */
export function PalettePreview({ palette }: { palette: AuxColor[] }) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (hex: string) => {
    void navigator.clipboard?.writeText(hex);
    setCopied(hex);
    window.setTimeout(
      () => setCopied((cur) => (cur === hex ? null : cur)),
      1100
    );
  };

  return (
    <div className="flex h-full w-full">
      {palette.map((c, i) => (
        <button
          key={`${c.hex}:${i}`}
          type="button"
          onClick={() => copy(c.hex)}
          title={`Copy ${c.hex}${
            c.proportion != null ? ` · ${Math.round(c.proportion * 100)}%` : ""
          }`}
          aria-label={`Copy ${c.hex}`}
          // Width tracks each color's share of the region (dominant colors
          // read wider); equal split for pre-proportion entries.
          style={{
            backgroundColor: c.hex,
            flexGrow: c.proportion ?? 1,
            flexBasis: 0,
          }}
          className="group/swatch relative flex h-full items-end justify-center overflow-hidden outline-none"
        >
          <span className="pointer-events-none w-full bg-gradient-to-t from-black/55 to-transparent px-1 pb-1 pt-3 text-center opacity-0 transition-opacity group-hover/swatch:opacity-100 group-focus-visible/swatch:opacity-100">
            <span className="block truncate font-mono text-[9px] font-semibold uppercase leading-tight text-white">
              {copied === c.hex ? "Copied" : c.hex}
            </span>
            {c.proportion != null ? (
              <span className="block text-[8px] leading-tight text-white/80">
                {Math.round(c.proportion * 100)}%
              </span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}
