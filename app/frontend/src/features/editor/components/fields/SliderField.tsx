import { useEffect, useRef, useState, type ChangeEvent } from "react";

/** Thumb diameter — mirrors `.clippity-editor .ed-slider` in theme.css. The
 *  thumb centre is inset half this from each rail end, so the fill uses the
 *  same inset and can't run ahead of (or trail) the thumb. */
const THUMB_PX = 13;

interface SliderFieldProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Commit handler — fires once the interaction settles (pointer-up, key-up,
   *  blur), not on every intermediate value. */
  onChange: (next: number) => void;
  ariaLabel: string;
  /** A multi-selection whose members disagree: the rail draws empty and the
   *  thumb sits at `min` until the user commits a value that unifies them. */
  mixed?: boolean;
  disabled?: boolean;
}

/**
 * Full-width inspector slider, sized for a property card rather than the
 * settings panel's fixed-width {@link TickedSlider}.
 *
 * Like that one it drives the thumb from **local state** and only calls
 * `onChange` when the gesture settles. Here the reason is history rather than
 * IPC: every intermediate value the editor store accepts becomes its own undo
 * step, so a single opacity drag would otherwise bury the previous state under
 * a hundred entries. An external change is adopted only while idle, so a store
 * write can't yank the thumb mid-drag.
 */
export function SliderField({
  value,
  min,
  max,
  step = 1,
  onChange,
  ariaLabel,
  mixed = false,
  disabled = false,
}: SliderFieldProps) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(value);
  const dragging = useRef(false);

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

  const pct = mixed || max <= min ? 0 : ((draft - min) / (max - min)) * 100;

  return (
    <span
      className="relative flex w-full items-center"
      style={{ height: THUMB_PX }}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 h-[3px] -translate-y-1/2 rounded-full bg-[var(--ed-control-bg)]"
        style={{ top: "50%" }}
      />
      <span
        aria-hidden
        className="absolute left-0 h-[3px] -translate-y-1/2 rounded-full bg-[var(--ed-text)]"
        style={{
          top: "50%",
          width: `calc(${THUMB_PX / 2}px + ${pct} / 100 * (100% - ${THUMB_PX}px))`,
          opacity: mixed ? 0 : 1,
        }}
      />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={mixed ? min : draft}
        disabled={disabled}
        onChange={onInput}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label={ariaLabel}
        className="ed-slider absolute inset-0 h-full w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      />
    </span>
  );
}
