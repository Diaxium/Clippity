import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "@shared/lib/cn";

import { MIXED_LABEL } from "../../lib/multi";
import { normalizeHex } from "../../lib/paint";

interface ColorFieldProps {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  /** When set, the swatch opens the floating color editor at this anchor
   *  (screen px) instead of the native OS picker (Workstream FE4). */
  onOpenEditor?: (anchor: { x: number; y: number }) => void;
  /** The selection disagrees on this color (P3): the hex reads empty behind a
   *  "Mixed" placeholder, while the swatch keeps showing the primary's color so
   *  the row still has a visual anchor. Typing a hex unifies the selection. */
  mixed?: boolean;
}

const HEX6 = /^[0-9a-fA-F]{6}$/;

/** Strip the leading `#` and upper-case for the editable text field. */
function toDisplay(hex: string): string {
  return hex.replace(/^#/, "").toUpperCase();
}

/**
 * Solid-color row: a swatch that opens the color editor plus an editable
 * 6-digit hex field. Commits (Enter/blur) run through `normalizeHex`; invalid
 * input reverts to the current value.
 *
 * The swatch is its own square button beside the field rather than a chip
 * inside it — at inspector scale a 16px chip tucked behind a border is a hard
 * target for the control that opens the color editor, which is the row's
 * primary action.
 */
export function ColorField({
  value,
  onChange,
  disabled = false,
  onOpenEditor,
  mixed = false,
}: ColorFieldProps) {
  const [draft, setDraft] = useState(() => (mixed ? "" : toDisplay(value)));
  const [focused, setFocused] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  // Empty while mixed — `HEX6` rejects "", so blurring an untouched mixed field
  // commits nothing and the selection keeps its individual colors.
  const resting = mixed ? "" : toDisplay(value);

  useEffect(() => {
    if (!focused) setDraft(resting);
  }, [resting, focused]);

  const commit = (): void => {
    if (HEX6.test(draft)) {
      onChange(normalizeHex(`#${draft}`));
    } else {
      setDraft(resting);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      commit();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setDraft(resting);
      e.currentTarget.blur();
    }
  };

  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-2",
        disabled && "opacity-40"
      )}
    >
      <button
        type="button"
        disabled={disabled}
        aria-label="Pick color"
        onClick={(e) => {
          if (onOpenEditor) {
            const r = e.currentTarget.getBoundingClientRect();
            onOpenEditor({ x: r.left, y: r.top });
          } else {
            pickerRef.current?.click();
          }
        }}
        className="h-8 w-8 shrink-0 rounded-[8px] border border-[color:var(--ed-control-hairline)]"
        style={{ background: value }}
      />
      <input
        ref={pickerRef}
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        value={normalizeHex(value)}
        onChange={(e) => onChange(normalizeHex(e.target.value))}
        className="pointer-events-none absolute bottom-0 left-1.5 h-0 w-0 opacity-0"
      />
      <input
        type="text"
        disabled={disabled}
        value={draft}
        maxLength={6}
        spellCheck={false}
        placeholder={mixed ? MIXED_LABEL : undefined}
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={onKeyDown}
        className="h-8 min-w-0 flex-1 rounded-[8px] border border-[color:var(--ed-control-hairline)] bg-[var(--ed-input-bg)] px-2.5 text-[12px] uppercase text-[var(--ed-text)] outline-none placeholder:normal-case placeholder:text-[var(--ed-text-faint)]"
      />
    </div>
  );
}
