import { useEffect, useRef, useState } from "react";

interface UseAutoDismissParams {
  /** True while a toast is being shown. When false the hook is a
   *  pure no-op — timers cleared, progress reset. */
  active: boolean;
  /** Auto-dismiss duration in ms. `0` (or less) means sticky — no
   *  timer, no progress bar. */
  durationMs: number;
  /** Pointer is currently over the toast. Pauses the timer + rAF
   *  loop; remaining time is preserved across the pause so resume
   *  continues from where the user paused (legacy behavior). */
  hovered: boolean;
  /** Fired when the timer reaches 0. Caller is expected to wrap in
   *  `useCallback` so the effect doesn't re-arm on every parent
   *  render. */
  onExpire: () => void;
}

interface UseAutoDismissResult {
  /** Remaining time as a fraction (1 = full, 0 = expired). For
   *  sticky toasts this stays at 1 forever — the `ProgressBar`
   *  component reads this to decide whether to render. */
  progress: number;
}

/**
 * Drive the toast auto-dismiss timer + the progress bar's rAF tick.
 *
 * **State machine:**
 * - `active=false` → idle; everything cleared.
 * - `durationMs <= 0` → sticky; no timer, `progress` stays at 1.
 * - `hovered=true` → paused; remaining time held in a ref so
 *   un-hovering continues from there (legacy `remainingRef` pattern,
 *   re-expressed as a state-machine-driven effect).
 * - active + duration > 0 + not hovered → schedule a `setTimeout`
 *   for the remaining ms and a `rAF` loop that ticks `progress`.
 *
 * The hook deliberately resets remaining on `[active, durationMs]`
 * changes so a new toast (or duration update) starts from full.
 */
export function useAutoDismiss({
  active,
  durationMs,
  hovered,
  onExpire,
}: UseAutoDismissParams): UseAutoDismissResult {
  const [progress, setProgress] = useState(1);
  /** ms left when the timer was last started / paused. Carries
   *  across hover toggles so resume picks up where pause left off. */
  const remainingRef = useRef(durationMs);
  /** performance.now() when the current timer started. Combined with
   *  `remainingRef` it lets the rAF loop compute elapsed without
   *  storing a per-tick startedAt. */
  const startedAtRef = useRef(0);
  const timeoutRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // Reset remaining + progress when the toast (or its duration)
  // changes. A fresh toast starts from full; a duration tweak (rare,
  // settings-port-driven) also restarts.
  useEffect(() => {
    remainingRef.current = durationMs;
    setProgress(1);
  }, [active, durationMs]);

  useEffect(() => {
    const clearTimers = () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    // Idle (no active toast) or sticky (duration <= 0) — no timer.
    if (!active || durationMs <= 0) {
      clearTimers();
      return;
    }

    // Paused: leave remaining in the ref, clear timers.
    if (hovered) {
      clearTimers();
      return;
    }

    // Schedule the dismiss + the progress tick.
    startedAtRef.current = performance.now();
    const remaining = Math.max(0, remainingRef.current);
    timeoutRef.current = window.setTimeout(() => {
      remainingRef.current = 0;
      onExpire();
    }, remaining);

    const tick = () => {
      const elapsed = performance.now() - startedAtRef.current;
      const left = Math.max(0, remaining - elapsed);
      remainingRef.current = left;
      setProgress(durationMs > 0 ? left / durationMs : 0);
      if (left > 0) rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);

    return clearTimers;
  }, [active, durationMs, hovered, onExpire]);

  return { progress };
}
