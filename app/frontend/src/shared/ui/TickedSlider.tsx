import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { cn } from "@shared/lib/cn";

import { TrackTicks, intervalFractions } from "./TrackTicks";

interface TickedSliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Commit handler — called once when the drag/keyboard interaction
   *  settles, NOT on every intermediate value. See the lag note below. */
  onChange: (next: number) => void;
  ariaLabel: string;
  /** Spacing (in value units) between interval tick lines. Ticks land on
   *  the multiples of this inside `(min, max)`, so they align with the
   *  thumb at those values. Omit / 0 to draw none. */
  tickStep?: number;
  /** Optional right-side readout, formatted from the LIVE draft value so
   *  it updates during a drag (the committed `value` lags until release). */
  formatValue?: (value: number) => string;
  /** Track width in px. */
  width?: number;
  disabled?: boolean;
}

/** Thumb diameter — mirrors `.clippity-slider::-webkit-slider-thumb` in
 *  theme.css. The thumb centre is inset half this from each rail edge,
 *  so the fill + ticks use the same inset to stay aligned. */
const THUMB_PX = 16;

/**
 * Range slider with value-aligned interval ticks and a fill bar.
 *
 * **Why it exists (lag fix):** the previous inline slider called its
 * `onChange` on every `input` event, and the settings panels wire that
 * straight to `useSettingsPatch` → a full `settings_update` IPC that
 * rewrites settings.json on disk and broadcasts an event. Dragging
 * fired dozens of those per second, so the thumb stuttered against the
 * disk + round-trip. Here the thumb is driven by **local state** for
 * instant motion, and `onChange` (the persist) fires only once the
 * interaction settles — on pointer-up, key-up, or blur. An external
 * value change (e.g. a settings/changed broadcast) is adopted only when
 * no drag is in progress, so a round-trip can't yank the thumb mid-drag.
 */
export function TickedSlider({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  tickStep = 0,
  formatValue,
  width = 160,
  disabled = false,
}: TickedSliderProps) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(value);
  const dragging = useRef(false);

  // Adopt external changes only when idle — never mid-drag.
  useEffect(() => {
    if (dragging.current) return;
    latest.current = value;
    setDraft(value);
  }, [value]);

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.currentTarget.value);
    dragging.current = true;
    latest.current = next;
    setDraft(next);
  };

  const commit = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (latest.current !== value) onChange(latest.current);
  };

  const pct = max > min ? ((draft - min) / (max - min)) * 100 : 0;
  const ticks = tickStep > 0 ? intervalFractions(min, max, tickStep) : [];

  return (
    <span className="inline-flex items-center gap-3">
      <span
        className="relative inline-flex items-center"
        style={{ width, height: THUMB_PX }}
      >
        {/* Rail */}
        <span
          aria-hidden
          className="absolute left-0 right-0 h-1 -translate-y-1/2 rounded-full bg-[color:var(--color-overlay-2)]"
          style={{ top: "50%" }}
        />
        {/* Filled portion (thumb-centre aligned) */}
        <span
          aria-hidden
          className="absolute left-0 h-1 -translate-y-1/2 rounded-full bg-[var(--color-accent)]"
          style={{
            top: "50%",
            width: `calc(${THUMB_PX / 2}px + ${pct} / 100 * (100% - ${THUMB_PX}px))`,
          }}
        />
        {/* Interval ticks — short rules bracketing the rail. */}
        <TrackTicks at={ticks} insetPx={THUMB_PX / 2} heightPct={58} />
        {/* The actual control — transparent rail (drawn above), accent
            thumb (via .clippity-slider). Sits on top to take all input. */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={draft}
          disabled={disabled}
          onChange={onInput}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          aria-label={ariaLabel}
          className={cn(
            "clippity-slider absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
        />
      </span>
      {formatValue && (
        <span className="w-14 text-right font-mono text-[12px] text-[var(--color-ink)]">
          {formatValue(draft)}
        </span>
      )}
    </span>
  );
}
