/**
 * Rolling record of what crossed the IPC bridge — duration, payload
 * sizes, outcome — for Settings → Advanced → command inspector.
 *
 * It lives in `shared/lib` rather than in the developer feature because
 * the recorder has to sit inside `services/tauri/client`, which every
 * IPC call funnels through. A feature importing *into* the service layer
 * would invert the dependency direction the app is built on; a shared
 * primitive that both sides use does not.
 *
 * **Off by default.** Recording retains command names and byte counts
 * for a rolling window, which is a (small) privacy surface and a (small)
 * cost on the hot path. `developer.commandTiming` arms it; until then
 * `record` returns before doing any work at all.
 */

/** One completed IPC call. */
export interface IpcSample {
  /** Monotonic within the process — a stable React key. */
  seq: number;
  command: string;
  /** Wall-clock duration, ms, measured at the invoke boundary. */
  ms: number;
  ok: boolean;
  /** `TauriCommandError.code` for a failed call. */
  code?: string;
  /** Approximate serialized size of the arguments, in bytes. */
  requestBytes: number;
  /** Approximate serialized size of the result, in bytes. */
  responseBytes: number;
  /** `Date.now()` at completion. */
  at: number;
}

/**
 * How many samples to keep. Two hundred covers "what just happened"
 * — the question the inspector answers — without holding a session's
 * worth of command metadata in memory.
 */
export const MAX_SAMPLES = 200;

/**
 * Payload sizing is skipped past this many characters. Measuring a
 * multi-megabyte base64 image costs more than the call it is describing,
 * and the number it would produce ("big") is already implied by the
 * duration beside it.
 */
const SIZING_LIMIT = 1_000_000;

let enabled = false;
let slowMs = 100;
let seq = 0;
let samples: IpcSample[] = [];
let pending = 0;
const listeners = new Set<() => void>();

/**
 * Note a call starting. Unlike sample recording this is **always** on:
 * it is a single counter holding no data about the call, and "how many
 * commands are in flight" is the one number that matters most exactly
 * when the app is too busy for anyone to have armed the recorder first.
 */
export function beginIpcCall(): void {
  pending += 1;
}

/** Note a call finishing, however it finished. */
export function endIpcCall(): void {
  pending = Math.max(0, pending - 1);
}

/** Calls started and not yet finished. */
export function pendingIpcCalls(): number {
  return pending;
}

/** Arm or disarm recording, and set the slow-command threshold. */
export function configureIpcMetrics(next: {
  enabled: boolean;
  slowMs?: number;
}): void {
  const was = enabled;
  enabled = next.enabled;
  if (typeof next.slowMs === "number" && next.slowMs > 0) slowMs = next.slowMs;
  // Turning it off drops what was collected: a rolling window of
  // command metadata should not outlive the switch that permitted it.
  if (was && !enabled) clearIpcSamples();
}

/** Whether recording is on. */
export function ipcMetricsEnabled(): boolean {
  return enabled;
}

/** The current slow-command threshold, in ms. */
export function slowCommandMs(): number {
  return slowMs;
}

/**
 * Record one completed call. A no-op while recording is off, which is
 * what keeps this affordable on the path every IPC call takes.
 */
export function recordIpcSample(sample: {
  command: string;
  ms: number;
  ok: boolean;
  code?: string;
  args?: unknown;
  result?: unknown;
}): void {
  if (!enabled) return;
  // A **new** array, not a push: the inspector reads this through
  // `useSyncExternalStore`, which compares snapshots by reference and
  // would skip the render if the same array were mutated in place.
  samples = [
    ...samples,
    {
      seq: ++seq,
      command: sample.command,
      ms: sample.ms,
      ok: sample.ok,
      code: sample.code,
      requestBytes: approximateBytes(sample.args),
      responseBytes: approximateBytes(sample.result),
      at: Date.now(),
    },
  ].slice(-MAX_SAMPLES);
  for (const listener of listeners) listener();
}

/** The recorded window, oldest first. */
export function getIpcSamples(): readonly IpcSample[] {
  return samples;
}

/** Drop every recorded sample. */
export function clearIpcSamples(): void {
  if (samples.length === 0) return;
  samples = [];
  for (const listener of listeners) listener();
}

/** Subscribe to changes; returns an unsubscribe. */
export function subscribeIpcMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Approximate serialized size, in bytes.
 *
 * Approximate on purpose: `JSON.stringify` on the argument the caller
 * already built is cheap, while an exact byte count would mean encoding
 * it a second time. Anything that can't be stringified (a circular
 * object, a `BigInt`) sizes as 0 rather than throwing inside the
 * instrumentation of an otherwise-successful call.
 */
export function approximateBytes(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    const json = JSON.stringify(value);
    if (!json) return 0;
    if (json.length > SIZING_LIMIT) return json.length;
    // Cheap UTF-8 estimate: ASCII dominates these payloads, and the
    // remainder is base64 (also ASCII).
    return json.length;
  } catch {
    return 0;
  }
}

/** Per-command rollup for the inspector's summary row. */
export interface IpcCommandSummary {
  command: string;
  calls: number;
  failed: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
}

/** What the inspector shows above the table. */
export interface IpcSummary {
  total: number;
  failed: number;
  /** Calls at or over the slow threshold. */
  slow: number;
  avgMs: number;
  /** 95th-percentile duration — the number that moves when something is
   *  occasionally, rather than always, slow. */
  p95Ms: number;
  /** Slowest commands first, by total time spent. */
  byCommand: IpcCommandSummary[];
}

/**
 * Pure: roll a window of samples up for display.
 *
 * Ranked by *total* time rather than by average, because a 4 ms command
 * called three hundred times is a real cost that a mean would hide
 * behind one 600 ms outlier.
 */
export function summarizeIpc(
  window: readonly IpcSample[],
  threshold = slowMs
): IpcSummary {
  if (window.length === 0) {
    return { total: 0, failed: 0, slow: 0, avgMs: 0, p95Ms: 0, byCommand: [] };
  }

  const byCommand = new Map<string, IpcCommandSummary>();
  let totalMs = 0;
  let failed = 0;
  let slow = 0;

  for (const sample of window) {
    totalMs += sample.ms;
    if (!sample.ok) failed += 1;
    if (sample.ms >= threshold) slow += 1;

    const entry = byCommand.get(sample.command) ?? {
      command: sample.command,
      calls: 0,
      failed: 0,
      totalMs: 0,
      avgMs: 0,
      maxMs: 0,
    };
    entry.calls += 1;
    if (!sample.ok) entry.failed += 1;
    entry.totalMs += sample.ms;
    entry.maxMs = Math.max(entry.maxMs, sample.ms);
    entry.avgMs = entry.totalMs / entry.calls;
    byCommand.set(sample.command, entry);
  }

  const sorted = [...window].map((s) => s.ms).sort((a, b) => a - b);
  // Nearest-rank: with 20 samples the p95 is the 19th, not an
  // interpolation between two of them nobody measured.
  const rank = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);

  return {
    total: window.length,
    failed,
    slow,
    avgMs: totalMs / window.length,
    p95Ms: sorted[rank] ?? 0,
    byCommand: [...byCommand.values()].sort((a, b) => b.totalMs - a.totalMs),
  };
}

/** Test seam — reset the module between cases. */
export function resetIpcMetrics(): void {
  enabled = false;
  slowMs = 100;
  seq = 0;
  samples = [];
  pending = 0;
  listeners.clear();
}
