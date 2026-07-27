interface CountdownProgressBarProps {
  /** 0..1 fraction of elapsed time. Width = (1 - progress). */
  progress: number;
}

/**
 * Progress line pinned to the very bottom edge of the strip — it sits
 * flush against the top of the taskbar (the layout column ends in this
 * element with no padding below it). Per the design spec: 2–4 px tall,
 * full-screen width, edge-to-edge with no margins.
 *
 * The fill shrinks from full width to 0 as `progress` runs 0..1. Its
 * background is the `--countdown-gradient` token (a soft accent→purple
 * sweep that adapts to the user's accent and collapses to a solid in
 * high-contrast / forced-colors mode) carried on the fill itself, so
 * both gradient hues stay visible no matter how short the bar gets.
 * A faint accent rail spans the full width behind the fill so the line
 * reads as a single element attached to the taskbar.
 */
export function CountdownProgressBar({ progress }: CountdownProgressBarProps) {
  const widthPct = Math.max(0, Math.min(1, 1 - progress)) * 100;
  return (
    <div
      className="relative h-[3px] w-full bg-[color:color-mix(in_srgb,var(--color-accent)_14%,transparent)]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(widthPct)}
    >
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: `${widthPct}%`,
          background: "var(--countdown-gradient)",
          boxShadow: "var(--countdown-glow)",
        }}
      />
    </div>
  );
}
