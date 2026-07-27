/**
 * Evenly-or-explicitly placed interval tick lines drawn over a track
 * (a slider rail or a progress bar). Purely decorative — `aria-hidden`,
 * `pointer-events-none` — so the host control keeps all interaction.
 *
 * Position the host as `relative`; `TrackTicks` fills it via `inset-0`
 * and paints one 1px vertical line per fraction in `at` (0 = left edge,
 * 1 = right edge). `insetPx` shrinks the usable span on each side so
 * ticks line up with a thumb's travel range (a range input's thumb
 * centre never reaches the rail's edges — it's inset by half the thumb
 * width), leaving progress bars (no thumb) at `insetPx = 0`.
 */
interface TrackTicksProps {
  /** Tick positions as fractions of the track, 0..1. */
  at: readonly number[];
  /** Horizontal inset (px) on each side — half the thumb width for a
   *  slider so ticks align with the thumb centre; 0 for a bare bar. */
  insetPx?: number;
  /** Tick height as a percent of the track height. < 100 centres a
   *  shorter tick vertically (a ruler look over a thin rail). */
  heightPct?: number;
  /** Tick colour. Defaults to a theme-aware ink mix that stays legible
   *  over both an empty rail and a filled (accent) portion. */
  color?: string;
}

export function TrackTicks({
  at,
  insetPx = 0,
  heightPct = 100,
  color = "color-mix(in srgb, var(--color-ink) 24%, transparent)",
}: TrackTicksProps) {
  if (at.length === 0) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0">
      {at.map((frac, i) => (
        <span
          key={i}
          className="absolute w-px -translate-x-1/2 rounded-full"
          style={{
            left: `calc(${insetPx}px + ${frac} * (100% - ${insetPx * 2}px))`,
            top: `${(100 - heightPct) / 2}%`,
            height: `${heightPct}%`,
            background: color,
          }}
        />
      ))}
    </span>
  );
}

/**
 * Interior tick fractions for a `[min, max]` range marked every `step`
 * units — i.e. the multiples of `step` strictly inside the range. Used
 * by `TickedSlider` to place value-aligned interval lines.
 */
export function intervalFractions(
  min: number,
  max: number,
  step: number
): number[] {
  if (step <= 0 || max <= min) return [];
  const out: number[] = [];
  // First multiple of `step` strictly greater than `min`.
  const first = Math.floor(min / step) * step + step;
  for (let v = first; v < max; v += step) {
    if (v > min) out.push((v - min) / (max - min));
  }
  return out;
}
