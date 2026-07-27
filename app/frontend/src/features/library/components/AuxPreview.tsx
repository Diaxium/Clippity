import type { CaptureMeta } from "../types";

/**
 * The visual for an aux (non-file) library entry — rendered in place of
 * the file thumbnail. A `color` is a full swatch with its hex; a
 * `palette` is an equal-width swatch strip; a `text` entry (grab-text
 * port) is a clipped preview. Fills its container.
 *
 * Swatch fills are runtime data (sampled / quantized colors), so they're
 * inline styles, not design tokens.
 */
export function AuxPreview({ meta }: { meta: CaptureMeta }) {
  if (meta.kind === "color" && meta.color) {
    return (
      <div
        className="relative flex h-full w-full items-end justify-start p-2"
        style={{ backgroundColor: meta.color.hex }}
      >
        <span className="rounded-md bg-black/40 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase text-white">
          {meta.color.hex}
        </span>
        <SwatchRing />
      </div>
    );
  }

  if (meta.kind === "palette" && meta.palette && meta.palette.length > 0) {
    return (
      <div className="relative flex h-full w-full">
        {meta.palette.map((c, i) => (
          <div
            key={`${c.hex}:${i}`}
            className="h-full"
            // Width tracks each color's share of the region (dominant
            // colors read wider); equal split for pre-proportion entries.
            style={{
              backgroundColor: c.hex,
              flexGrow: c.proportion ?? 1,
              flexBasis: 0,
            }}
            title={
              c.proportion != null
                ? `${c.hex} · ${Math.round(c.proportion * 100)}%`
                : c.hex
            }
          />
        ))}
        <SwatchRing />
      </div>
    );
  }

  if (meta.kind === "text" && meta.text) {
    return (
      <div className="h-full w-full overflow-hidden p-3">
        <p className="line-clamp-4 text-[11px] leading-snug text-[var(--color-slate)]">
          {meta.text}
        </p>
      </div>
    );
  }

  // Aux entry with a missing payload — defensive fallback.
  return <div className="h-full w-full bg-[var(--color-surface-2)]" />;
}

/** Inset hairline over a swatch surface so colors that match the row /
 *  card background (near-black in dark mode, near-white in light) still
 *  read as content instead of vanishing. */
function SwatchRing() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-[inherit]"
      style={{ boxShadow: "inset 0 0 0 1px var(--hairline)" }}
    />
  );
}
