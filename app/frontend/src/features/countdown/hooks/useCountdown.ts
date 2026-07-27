/**
 * Countdown controller.
 *
 * Subscribes to `clippity://countdown/start` and owns the tick: the
 * per-second decrement + the smooth progress interpolation + the
 * tick-to-zero `finish` dispatch all live here. Cancellation is owned
 * by the BACKEND — the countdown window is click-through and never
 * focused (design spec: "do not steal focus", "do not prevent
 * interaction"), so it can't receive a keydown. Instead the backend
 * registers a global Escape shortcut while the strip is visible; when
 * it fires it cancels and emits `clippity://countdown/cancelled`,
 * which this hook listens for to stop the tick.
 *
 * Returned state shape:
 * - `total`     — seconds the timer started with (used by the
 *                 progress bar's full-width baseline).
 * - `remaining` — seconds left, integer; null while idle.
 * - `progress`  — 0..1 fraction of time consumed; smoothly
 *                 interpolated each animation frame so the bar
 *                 shrinks continuously instead of jumping each
 *                 whole second.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  finishCountdown,
  onCountdownCancelled,
  onCountdownStart,
  type CountdownStartEvent,
} from "@services/tauri/clients/countdown";

export interface CountdownState {
  /** Seconds the timer started with — 0 while idle. */
  total: number;
  /** Whole seconds remaining; null while idle. */
  remaining: number | null;
  /** 0..1 fraction of elapsed time. Smoothly interpolated via rAF. */
  progress: number;
  /** True while the timer is mounted + counting (remaining > 0). */
  active: boolean;
}

const IDLE: CountdownState = {
  total: 0,
  remaining: null,
  progress: 0,
  active: false,
};

export function useCountdown(): CountdownState {
  const [state, setState] = useState<CountdownState>(IDLE);

  // Mutable refs cover the per-event-handler concerns (we don't want
  // to re-bind the tick every render): startedAt pinpoints the rAF
  // baseline, totalRef carries the originally requested seconds,
  // doneRef makes finish + external-cancel mutually exclusive on the
  // boundary tick.
  const startedAtRef = useRef<number>(0);
  const totalRef = useRef<number>(0);
  const doneRef = useRef<boolean>(true);
  const rafRef = useRef<number | null>(null);

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    stopRaf();
    setState(IDLE);
    void finishCountdown();
  }, [stopRaf]);

  // rAF tick — runs while a countdown is active. Re-reads the wall
  // clock each frame so a throttled webview catches up to wall-time on
  // resume instead of accumulating dropped frames.
  useEffect(() => {
    if (state.total === 0) return;
    const loop = () => {
      const elapsed = (performance.now() - startedAtRef.current) / 1000;
      const remaining = Math.max(0, totalRef.current - elapsed);
      const progress = Math.min(1, elapsed / totalRef.current);
      const wholeRemaining = Math.max(0, Math.ceil(remaining));
      setState((prev) => {
        // Suppress identical updates so the bar doesn't trigger a
        // useless rerender on every rAF frame when remaining/progress
        // haven't changed at React's float precision.
        if (
          prev.remaining === wholeRemaining &&
          Math.abs(prev.progress - progress) < 0.005
        ) {
          return prev;
        }
        return {
          total: totalRef.current,
          remaining: wholeRemaining,
          progress,
          active: true,
        };
      });
      if (remaining <= 0) {
        finish();
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return stopRaf;
  }, [state.total, finish, stopRaf]);

  // Subscribe to the start event — Rust positions + shows the window
  // then emits, so by the time this fires the strip is visible.
  useEffect(() => {
    const handler = (event: CountdownStartEvent) => {
      doneRef.current = false;
      totalRef.current = event.seconds;
      startedAtRef.current = performance.now();
      setState({
        total: event.seconds,
        remaining: event.seconds,
        progress: 0,
        active: true,
      });
    };
    return onCountdownStart(handler);
  }, []);

  // Backend-initiated cancel (global Esc). Stop the tick and reset so
  // a near-zero tick can't still fire `finish` after the user aborted.
  // We do NOT call `cancelCountdown()` back — the backend already ran
  // cancel (that's what emitted this event); echoing it would loop.
  useEffect(() => {
    return onCountdownCancelled(() => {
      if (doneRef.current) return;
      doneRef.current = true;
      stopRaf();
      setState(IDLE);
    });
  }, [stopRaf]);

  return state;
}
