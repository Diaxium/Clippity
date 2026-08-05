/**
 * The right-hand control for one rebindable shortcut: the current combo(s)
 * as key-caps, a record button that captures a new combo, and — when the
 * binding is customized — Reset (back to default) and Unbind (×) controls.
 *
 * Purely presentational over its props; the owning panel holds the combos
 * and persists changes. Reused by every catalog row and the global-capture
 * field.
 */

import { RotateCcw, X } from "lucide-react";

import { formatCombo } from "@features/editor/keybinds/keybindUtils";
import { cn } from "@shared/lib/cn";

import { useComboRecorder } from "./useComboRecorder";

interface KeyRecorderFieldProps {
  /** Effective combos in author notation (empty = unbound). */
  combos: string[];
  /** Accessible name for the record button ("Record shortcut for Undo"). */
  actionLabel: string;
  /** Whether this binding is currently customized (shows Reset). */
  overridden: boolean;
  /** Whether the binding collides with another in its scope + context. */
  conflict?: boolean;
  /** Capture a new combo — replaces the binding. */
  onRecord(combo: string): void;
  /** Restore the registry default. */
  onReset(): void;
  /** Deliberately unbind (empty combo list). Omit to hide the × control. */
  onClear?(): void;
}

function Cap({ label }: { label: string }) {
  return (
    <kbd className="rounded-[5px] border border-[color:var(--hairline)] bg-[var(--color-overlay-1)] px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-none text-[var(--color-ink)]">
      {label}
    </kbd>
  );
}

export function KeyRecorderField({
  combos,
  actionLabel,
  overridden,
  conflict,
  onRecord,
  onReset,
  onClear,
}: KeyRecorderFieldProps) {
  const recorder = useComboRecorder(onRecord);

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={recorder.recording ? recorder.cancel : recorder.start}
        aria-label={
          recorder.recording
            ? `Recording ${actionLabel} — press Esc to cancel`
            : `Record shortcut for ${actionLabel}`
        }
        aria-keyshortcuts={combos[0] ?? undefined}
        className={cn(
          "focus-ring flex min-h-[30px] min-w-[128px] items-center justify-center gap-1.5 rounded-[8px] border px-2.5 py-1 transition-colors",
          recorder.recording
            ? "border-[color:var(--color-accent)] bg-[var(--color-accent-soft)]"
            : conflict
              ? "border-[color:var(--color-danger)] bg-[var(--color-surface)] hover:bg-[var(--color-overlay-1)]"
              : "border-[color:var(--hairline)] bg-[var(--color-surface)] hover:bg-[var(--color-overlay-1)]"
        )}
      >
        {recorder.recording ? (
          <span className="text-[12px] font-medium text-[var(--color-accent)]">
            Press keys…
          </span>
        ) : combos.length === 0 ? (
          <span className="text-[12px] italic text-[var(--color-hint)]">
            Unbound
          </span>
        ) : (
          <span className="flex flex-wrap items-center justify-center gap-1">
            {combos.map((combo, ci) => (
              <span key={combo} className="flex items-center gap-1">
                {ci > 0 && (
                  <span className="text-[10px] text-[var(--color-hint)]">
                    or
                  </span>
                )}
                {formatCombo(combo).map((k, ki) => (
                  <Cap key={`${combo}-${ki}`} label={k} />
                ))}
              </span>
            ))}
          </span>
        )}
      </button>

      {onClear && combos.length > 0 && !recorder.recording && (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Unbind ${actionLabel}`}
          title="Unbind"
          className="focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[var(--color-hint)] hover:bg-[var(--color-overlay-1)] hover:text-[var(--color-ink)]"
        >
          <X size={14} strokeWidth={1.9} />
        </button>
      )}

      <button
        type="button"
        onClick={onReset}
        disabled={!overridden}
        aria-label={`Reset ${actionLabel} to default`}
        title="Reset to default"
        className={cn(
          "focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-[7px] transition-colors",
          overridden
            ? "text-[var(--color-slate)] hover:bg-[var(--color-overlay-1)] hover:text-[var(--color-ink)]"
            : "cursor-default text-[var(--color-hint)] opacity-40"
        )}
      >
        <RotateCcw size={14} strokeWidth={1.9} />
      </button>
    </div>
  );
}
