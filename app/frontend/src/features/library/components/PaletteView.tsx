import { useState } from "react";

import { ArrowLeft, Palette } from "lucide-react";

import { usePaletteEntry } from "../hooks/usePaletteEntry";
import { PaletteCopyControl } from "./PaletteCopyControl";

interface PaletteViewProps {
  /** Aux id of the palette to show (from the dashboard handoff). */
  id: string | null;
  /** Return to the library view. */
  onBack: () => void;
}

/**
 * Large, read-and-copy view of a single saved palette — the main-window
 * counterpart to the cramped library card. Renders every swatch big in a
 * responsive grid (so a 16-color palette is still legible), each showing
 * its hex, RGB, and share of the region, and copying its own hex on
 * click. The header carries the whole-palette format export (HEX / RGB /
 * HSL / CSS / JSON / Tailwind) and a back button.
 */
export function PaletteView({ id, onBack }: PaletteViewProps) {
  const { entry, loading } = usePaletteEntry(id);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (hex: string) => {
    void navigator.clipboard?.writeText(hex);
    setCopied(hex);
    window.setTimeout(
      () => setCopied((cur) => (cur === hex ? null : cur)),
      1100
    );
  };

  const palette = entry?.palette ?? [];
  const missing = !loading && (!entry || palette.length === 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[color:var(--hairline)] px-7 py-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to library"
          title="Back to library"
          className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
        >
          <ArrowLeft size={17} strokeWidth={1.85} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Palette
            size={18}
            strokeWidth={1.85}
            className="shrink-0 text-[var(--color-accent)]"
          />
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold text-[var(--color-ink)]">
              {entry?.title ?? "Palette"}
            </h1>
            {palette.length > 0 ? (
              <p className="text-[11.5px] text-[var(--color-hint)]">
                {palette.length} color{palette.length === 1 ? "" : "s"} · click
                a swatch to copy its hex
              </p>
            ) : null}
          </div>
        </div>
        {palette.length > 0 ? <PaletteCopyControl palette={palette} /> : null}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-7 py-6">
        {loading ? (
          <p className="grid h-full place-items-center text-[13px] text-[var(--color-hint)]">
            Loading…
          </p>
        ) : missing ? (
          <div className="grid h-full place-items-center text-center">
            <div className="flex flex-col items-center gap-2">
              <Palette
                size={28}
                strokeWidth={1.5}
                className="text-[var(--color-hint)]"
              />
              <p className="text-[13px] text-[var(--color-hint)]">
                This palette is no longer available.
              </p>
              <button
                type="button"
                onClick={onBack}
                className="focus-ring rounded-lg border border-[color:var(--hairline)] px-3 py-1.5 text-[12px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[color:var(--color-overlay-1)]"
              >
                Back to library
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
            {palette.map((c, i) => (
              <button
                key={`${c.hex}:${i}`}
                type="button"
                onClick={() => copy(c.hex)}
                aria-label={`Copy ${c.hex}`}
                title={`Copy ${c.hex}`}
                className="focus-ring group/swatch flex flex-col overflow-hidden rounded-xl border border-[color:var(--hairline)] bg-[var(--color-surface)] text-left shadow-[var(--shadow-subtle)] transition-shadow hover:shadow-[var(--shadow-medium)]"
              >
                <span
                  className="h-28 w-full transition-transform group-hover/swatch:scale-[1.02]"
                  style={{ backgroundColor: c.hex }}
                />
                <span className="flex flex-col gap-0.5 px-3 py-2.5">
                  <span className="font-mono text-[13px] font-semibold uppercase text-[var(--color-ink)]">
                    {copied === c.hex ? "Copied!" : c.hex}
                  </span>
                  <span className="text-[11px] text-[var(--color-hint)]">
                    rgb({c.r}, {c.g}, {c.b})
                    {c.proportion != null
                      ? ` · ${Math.round(c.proportion * 100)}%`
                      : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
