/**
 * Live frontend performance sampling — frame rate, frame time, main-
 * thread delay, heap, and IPC throughput.
 *
 * A module-level sampler rather than a hook so the overlay and the
 * settings panel read the *same* numbers: two independent rAF loops
 * would each be measuring a window that includes the other.
 *
 * The measurement half is pure and unit-tested ([`summarizeFrames`],
 * [`ipcPerSecond`]); the loop around it is the part that needs a
 * browser.
 */

import { getIpcSamples, pendingIpcCalls } from "@shared/lib/ipcMetrics";

/** One sampling window's worth of numbers. */
export interface PerfSample {
  /** Frames per second over the window. */
  fps: number;
  /** Mean frame interval, ms. */
  frameMs: number;
  /** Worst frame interval in the window, ms — where a stutter shows. */
  worstFrameMs: number;
  /**
   * Main-thread delay: how late a zero-delay timer actually fired, ms.
   * The number that says "something is blocking", which a frame rate
   * alone does not — a window with nothing animating has a low frame
   * rate and a perfectly responsive main thread.
   */
  mainThreadDelayMs: number;
  /** JS heap in use, MB, when the engine reports it (Chromium does). */
  heapMb: number | null;
  /** Heap limit, MB, when reported. */
  heapLimitMb: number | null;
  /** IPC calls completed per second over the window. */
  ipcPerSecond: number;
  /** IPC calls in flight — started and not yet recorded. */
  ipcPending: number;
}

/** The zero sample, for a first render with nothing measured yet. */
export const EMPTY_SAMPLE: PerfSample = {
  fps: 0,
  frameMs: 0,
  worstFrameMs: 0,
  mainThreadDelayMs: 0,
  heapMb: null,
  heapLimitMb: null,
  ipcPerSecond: 0,
  ipcPending: 0,
};

/**
 * Pure: frame rate and frame timing from a window of frame timestamps.
 *
 * Fewer than two timestamps is not "0 fps" — it is "not measured yet",
 * which the zero sample already says; returning a computed zero would
 * make a just-opened overlay claim the app is frozen.
 */
export function summarizeFrames(
  timestamps: readonly number[]
): Pick<PerfSample, "fps" | "frameMs" | "worstFrameMs"> {
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  if (timestamps.length < 2 || first === undefined || last === undefined) {
    return { fps: 0, frameMs: 0, worstFrameMs: 0 };
  }
  let worst = 0;
  for (let i = 1; i < timestamps.length; i += 1) {
    const current = timestamps[i];
    const previous = timestamps[i - 1];
    if (current === undefined || previous === undefined) continue;
    worst = Math.max(worst, current - previous);
  }
  const span = last - first;
  const intervals = timestamps.length - 1;
  if (span <= 0) return { fps: 0, frameMs: 0, worstFrameMs: worst };
  return {
    fps: (intervals * 1000) / span,
    frameMs: span / intervals,
    worstFrameMs: worst,
  };
}

/** Pure: IPC calls per second among samples completed since `since`. */
export function ipcPerSecond(
  samples: readonly { at: number }[],
  since: number,
  now: number
): number {
  const windowMs = now - since;
  if (windowMs <= 0) return 0;
  const count = samples.filter((s) => s.at > since).length;
  return (count * 1000) / windowMs;
}

/** Chromium's non-standard heap readout, when present. */
interface MemoryInfo {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function heap(): Pick<PerfSample, "heapMb" | "heapLimitMb"> {
  const memory = (performance as Performance & { memory?: MemoryInfo }).memory;
  if (!memory) return { heapMb: null, heapLimitMb: null };
  return {
    heapMb: memory.usedJSHeapSize / (1024 * 1024),
    heapLimitMb: memory.jsHeapSizeLimit / (1024 * 1024),
  };
}

type Listener = (sample: PerfSample) => void;

const listeners = new Set<Listener>();
let frames: number[] = [];
let rafHandle: number | null = null;
let timerHandle: ReturnType<typeof setInterval> | null = null;
let lastWindowAt = 0;
let latest: PerfSample = EMPTY_SAMPLE;

/**
 * Subscribe to samples. The loop runs only while somebody is listening
 * — a performance overlay that kept a `requestAnimationFrame` loop
 * alive after being closed would be a measurement that causes the thing
 * it measures.
 */
export function subscribePerf(
  listener: Listener,
  intervalMs = 500
): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start(intervalMs);
  listener(latest);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** The most recent sample, without subscribing. */
export function latestPerfSample(): PerfSample {
  return latest;
}

function start(intervalMs: number) {
  frames = [];
  lastWindowAt = Date.now();

  const onFrame = (timestamp: number) => {
    frames.push(timestamp);
    rafHandle = requestAnimationFrame(onFrame);
  };
  rafHandle = requestAnimationFrame(onFrame);

  timerHandle = setInterval(() => {
    const now = Date.now();
    latest = {
      ...summarizeFrames(frames),
      // An interval that fired later than it was scheduled for was
      // waiting on a busy main thread — which is the thing a frame rate
      // alone doesn't say, since a window with nothing animating has a
      // low frame rate and a perfectly responsive thread.
      mainThreadDelayMs: Math.max(0, now - lastWindowAt - intervalMs),
      ...heap(),
      // Throughput is measured over completed calls; `getIpcSamples`
      // only holds them while `commandTiming` is armed, so this reads 0
      // when the recorder is off. Pending is always counted.
      ipcPerSecond: ipcPerSecond(getIpcSamples(), lastWindowAt, now),
      ipcPending: pendingIpcCalls(),
    };
    // Carry the last timestamp into the next window so the interval
    // spanning the boundary isn't lost.
    const carry = frames[frames.length - 1];
    frames = carry === undefined ? [] : [carry];
    lastWindowAt = now;
    for (const listener of listeners) listener(latest);
  }, intervalMs);
}

function stop() {
  if (rafHandle !== null) cancelAnimationFrame(rafHandle);
  if (timerHandle !== null) clearInterval(timerHandle);
  rafHandle = null;
  timerHandle = null;
  frames = [];
  latest = EMPTY_SAMPLE;
}
