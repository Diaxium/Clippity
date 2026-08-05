import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";

import { cn } from "@shared/lib/cn";

import { evalNumberExpression } from "../../lib/expr";
import { MIXED_LABEL } from "../../lib/multi";
import { useEditorStore } from "../../state/editorStore";

interface NumberFieldProps {
  value: number;
  onChange: (n: number) => void;
  label?: string;
  icon?: ReactNode;
  min?: number;
  max?: number;
  /** Units per pixel scrubbed and per arrow-key nudge. Defaults to 1. */
  step?: number;
  suffix?: string;
  disabled?: boolean;
  /**
   * The selection disagrees on this value (Workstream P3). The field reads
   * empty with a "Mixed" placeholder instead of claiming the primary's number,
   * but stays fully live: typing, nudging or scrubbing commits a real value —
   * which is exactly the unify-the-selection gesture Figma's mixed fields make.
   * `value` still carries the primary's number so a scrub has a starting point.
   */
  mixed?: boolean;
}

/** Horizontal travel (px) before a press is treated as a scrub, not a click. */
const SCRUB_THRESHOLD = 3;

/** Trim float noise (e.g. 0.1 * 100 = 10.0000…2) to a clean display string. */
function formatNum(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "";
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Sensitivity from held modifiers: Shift coarsens ×10, Alt refines ×0.1. */
function modifierFactor(e: { shiftKey: boolean; altKey: boolean }): number {
  if (e.shiftKey) return 10;
  if (e.altKey) return 0.1;
  return 1;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  startValue: number;
  active: boolean;
}

/**
 * Compact numeric chip. The *whole* field is drag-scrubbable: a horizontal drag
 * past a small threshold scrubs the value (Shift = ×10, Alt = ×0.1), so
 * suffix-only fields like Opacity scrub exactly like X/Y/radius — not just the
 * ones that happen to carry a label or icon. A plain click still focuses for
 * typing; commit on Enter/blur evaluates simple arithmetic ("100/2"), and ↑/↓
 * nudge by `step` (Shift ×10, Alt ×0.1). A draft string is held while focused so
 * partial input ("-", "1.") doesn't fight the parsed value.
 *
 * Each gesture is wrapped in a store history transaction (begin/endHistory) so a
 * continuous scrub or a held-arrow nudge collapses to a single undo step instead
 * of one per pointer-move / key-repeat.
 */
export function NumberField({
  value,
  onChange,
  label,
  icon,
  min,
  max,
  step,
  suffix,
  disabled = false,
  mixed = false,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(() => (mixed ? "" : formatNum(value)));
  const [focused, setFocused] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Open history transactions, tracked per gesture kind (a pointer scrub and a
  // keyboard-nudge burst are independent) so each closes exactly once.
  const scrubTxnRef = useRef(false);
  const nudgeTxnRef = useRef(false);

  // What the field shows when it isn't being typed into. A mixed selection rests
  // empty and lets the placeholder speak; `evalNumberExpression("")` is null, so
  // blurring an untouched mixed field can't silently unify the selection.
  const resting = mixed ? "" : formatNum(value);

  useEffect(() => {
    if (!focused) setDraft(resting);
  }, [resting, focused]);

  // Close any transaction still open if the field unmounts mid-gesture.
  useEffect(() => {
    return () => {
      const { endHistory } = useEditorStore.getState();
      if (scrubTxnRef.current) endHistory();
      if (nudgeTxnRef.current) endHistory();
      scrubTxnRef.current = false;
      nudgeTxnRef.current = false;
    };
  }, []);

  const clamp = (n: number): number => {
    let r = n;
    if (min !== undefined && r < min) r = min;
    if (max !== undefined && r > max) r = max;
    return r;
  };

  const beginTxn = (ref: { current: boolean }): void => {
    if (ref.current) return;
    ref.current = true;
    useEditorStore.getState().beginHistory();
  };
  const endTxn = (ref: { current: boolean }): void => {
    if (!ref.current) return;
    ref.current = false;
    useEditorStore.getState().endHistory();
  };

  /** Parse the draft as an arithmetic expression, trimming a trailing suffix
   *  (so "50%" in a `%` field still resolves to 50). */
  const parseDraft = (): number | null => {
    let body = draft.trim();
    if (suffix && body.endsWith(suffix)) body = body.slice(0, -suffix.length);
    return evalNumberExpression(body);
  };

  const commit = (): void => {
    const parsed = parseDraft();
    if (parsed !== null) {
      const next = clamp(round3(parsed));
      onChange(next);
      setDraft(formatNum(next));
    } else {
      setDraft(resting);
    }
  };

  const nudge = (dir: 1 | -1, e: ReactKeyboardEvent): void => {
    const from = parseDraft() ?? value;
    const next = clamp(round3(from + dir * (step ?? 1) * modifierFactor(e)));
    onChange(next);
    setDraft(formatNum(next));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      commit();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setDraft(resting);
      e.currentTarget.blur();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      beginTxn(nudgeTxnRef);
      nudge(1, e);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      beginTxn(nudgeTxnRef);
      nudge(-1, e);
    }
  };

  // A nudge burst closes when the arrow is released (or on blur / unmount).
  const onKeyUp = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") endTxn(nudgeTxnRef);
  };

  // ----- whole-field drag scrub -----
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || e.button !== 0) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startValue: value,
      active: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      // Require horizontal intent so a vertical drag still scrolls the panel.
      if (Math.abs(dx) <= SCRUB_THRESHOLD || Math.abs(dx) < Math.abs(dy))
        return;
      drag.active = true;
      setScrubbing(true);
      beginTxn(scrubTxnRef);
      containerRef.current?.setPointerCapture?.(drag.pointerId);
      // Drop the caret so the held draft doesn't clobber the scrubbed value.
      if (document.activeElement === inputRef.current) inputRef.current?.blur();
    }
    e.preventDefault();
    const dx = e.clientX - drag.startX;
    onChange(
      clamp(round3(drag.startValue + dx * (step ?? 1) * modifierFactor(e)))
    );
  };

  const endScrub = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (drag.active) {
      setScrubbing(false);
      endTxn(scrubTxnRef);
      if (containerRef.current?.hasPointerCapture?.(drag.pointerId)) {
        containerRef.current.releasePointerCapture(drag.pointerId);
      }
    }
  };

  const handle = icon ?? label;
  const scrubCursor = !disabled && !focused;

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endScrub}
      onPointerCancel={endScrub}
      className={cn(
        "flex h-8 min-w-0 items-center gap-1.5 rounded-[8px] border border-[color:var(--ed-control-hairline)] bg-[var(--ed-input-bg)] px-2",
        disabled && "opacity-40",
        scrubCursor && "cursor-ew-resize",
        scrubbing && "select-none"
      )}
    >
      {handle !== undefined && (
        <span
          className={cn(
            "flex shrink-0 select-none items-center text-[11px] text-[var(--ed-text-dim)]",
            !disabled && "cursor-ew-resize"
          )}
        >
          {handle}
        </span>
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        disabled={disabled}
        value={draft}
        placeholder={mixed ? MIXED_LABEL : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          endTxn(nudgeTxnRef);
          // Skip commit when blur was triggered by a starting scrub (the draft
          // is stale; the scrub already drives onChange).
          if (!dragRef.current?.active) commit();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-[12px] text-[var(--ed-text)] outline-none",
          "placeholder:text-[var(--ed-text-faint)]",
          scrubCursor && "cursor-ew-resize"
        )}
      />
      {suffix !== undefined && (
        <span className="shrink-0 select-none text-[11px] text-[var(--ed-text-faint)]">
          {suffix}
        </span>
      )}
    </div>
  );
}
