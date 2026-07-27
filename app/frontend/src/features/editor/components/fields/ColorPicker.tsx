import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import {
  hexToHsv,
  hsvToHex,
  normalizeHex,
  rgba,
  type Hsv,
} from "../../lib/paint";

interface ColorPickerProps {
  color: string;
  opacity: number;
  onChange: (color: string, opacity: number) => void;
}

const HEX6 = /^[0-9a-fA-F]{6}$/;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Checkerboard behind the alpha track (and any translucent swatch). */
const CHECKER =
  "repeating-conic-gradient(#888 0% 25%, #bbb 0% 50%) 50% / 10px 10px";

/**
 * HSV color picker: saturation/value square, hue + alpha sliders, hex + opacity
 * inputs. Hue/SV are held locally so dragging into pure black/white doesn't lose
 * the hue; external `color` changes resync. Emits `#rrggbb` + 0..1 opacity.
 */
export function ColorPicker({ color, opacity, onChange }: ColorPickerProps) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(color));
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  // Resync from an external color (e.g. switching fills), but ignore our own
  // round-trips so editing toward black/white keeps the hue.
  useEffect(() => {
    if (hsvToHex(hsv) !== normalizeHex(color)) setHsv(hexToHsv(color));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

  const emit = (next: Hsv, nextOpacity = opacity): void => {
    setHsv(next);
    onChange(hsvToHex(next), nextOpacity);
  };

  // Track a pointer drag over `el`, reporting clamped 0..1 fractions until release.
  const drag = (
    e: ReactPointerEvent,
    onPos: (fx: number, fy: number) => void
  ): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const report = (cx: number, cy: number) =>
      onPos(
        clamp01((cx - rect.left) / rect.width),
        clamp01((cy - rect.top) / rect.height)
      );
    report(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => report(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const hex = hsvToHex(hsv);
  const solid = rgba(hex, 1);

  const commitHex = (): void => {
    if (hexDraft !== null && HEX6.test(hexDraft))
      emit(hexToHsv(`#${hexDraft}`));
    setHexDraft(null);
  };

  return (
    <div className="flex flex-col gap-2.5">
      {/* Saturation / Value square */}
      <div
        className="relative h-32 w-full cursor-crosshair rounded-[6px]"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), hsl(${hsv.h}, 100%, 50%)`,
        }}
        onPointerDown={(e) =>
          drag(e, (fx, fy) => emit({ h: hsv.h, s: fx, v: 1 - fy }))
        }
      >
        <Thumb left={hsv.s} top={1 - hsv.v} color={solid} />
      </div>

      {/* Hue */}
      <div
        className="relative h-3 w-full cursor-pointer rounded-full"
        style={{
          background:
            "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
        onPointerDown={(e) =>
          drag(e, (fx) => emit({ h: fx * 360, s: hsv.s, v: hsv.v }))
        }
      >
        <Thumb
          left={hsv.h / 360}
          top={0.5}
          color={`hsl(${hsv.h}, 100%, 50%)`}
        />
      </div>

      {/* Alpha */}
      <div
        className="relative h-3 w-full cursor-pointer rounded-full"
        style={{ background: CHECKER }}
      >
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: `linear-gradient(to right, transparent, ${solid})`,
          }}
          onPointerDown={(e) => drag(e, (fx) => emit(hsv, clamp01(fx)))}
        />
        <Thumb left={clamp01(opacity)} top={0.5} color={rgba(hex, opacity)} />
      </div>

      {/* Hex + opacity */}
      <div className="flex items-center gap-1.5">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[6px] bg-[var(--ed-input-bg)] px-1.5">
          <span className="text-[12px] text-[var(--ed-text-dim)]">#</span>
          <input
            value={(hexDraft ?? hex.replace(/^#/, "")).toUpperCase()}
            maxLength={6}
            spellCheck={false}
            onChange={(e) =>
              setHexDraft(e.target.value.replace(/[^0-9a-fA-F]/g, ""))
            }
            onBlur={commitHex}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitHex();
                e.currentTarget.blur();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[12px] uppercase text-[var(--ed-text)] outline-none"
          />
        </div>
        <div className="flex h-7 w-16 shrink-0 items-center rounded-[6px] bg-[var(--ed-input-bg)] px-1.5">
          <input
            type="number"
            min={0}
            max={100}
            value={Math.round(opacity * 100)}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange(hex, clamp01(v / 100));
            }}
            className="min-w-0 flex-1 bg-transparent text-right text-[12px] tabular-nums text-[var(--ed-text)] outline-none"
          />
          <span className="pl-0.5 text-[12px] text-[var(--ed-text-dim)]">
            %
          </span>
        </div>
      </div>
    </div>
  );
}

function Thumb({
  left,
  top,
  color,
}: {
  left: number;
  top: number;
  color: string;
}) {
  return (
    <span
      className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
      style={{
        left: `${left * 100}%`,
        top: `${top * 100}%`,
        background: color,
        boxShadow: "0 0 0 1px rgba(0,0,0,.4)",
      }}
    />
  );
}
