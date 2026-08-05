/**
 * The floating performance readout — frame rate, frame time, main-
 * thread delay, heap, and IPC throughput, in the corner of the window.
 *
 * Mounted from `Providers` (so every chrome window can show it) and
 * rendered only while `developer.performanceOverlay` is on. The sampler
 * it reads from starts on the first subscriber and stops on the last,
 * so a hidden overlay costs nothing — measurement that outlives its
 * reader would be a cost the measurement itself is blamed for.
 *
 * Click-through (`pointer-events: none`) except for its own drag-free
 * corner switch: it sits over the app, and a diagnostic that swallows
 * clicks on what it is diagnosing is worse than no diagnostic.
 */

import { useEffect, useState } from "react";

import { cn } from "@shared/lib/cn";
import { PERF_SAMPLE_MS } from "@features/settings/constants";

import {
  EMPTY_SAMPLE,
  subscribePerf,
  type PerfSample,
} from "../lib/perfSampler";

/** Frame rate below this reads as a problem worth colouring. */
const FPS_WARN = 45;
/** Main-thread delay above this means something is blocking. */
const DELAY_WARN_MS = 50;

export function PerformanceOverlay() {
  const [sample, setSample] = useState<PerfSample>(EMPTY_SAMPLE);

  useEffect(() => subscribePerf(setSample, PERF_SAMPLE_MS), []);

  return (
    <div
      // `fixed` + top layer: the overlay has to sit above the app's own
      // stacking contexts without joining any of them.
      className="pointer-events-none fixed right-3 bottom-3 z-[9999] select-none"
      aria-hidden
    >
      <div className="rounded-[var(--radius-md)] border border-[color:var(--hairline)] bg-[var(--color-surface)]/95 px-3 py-2 font-mono text-[11px] leading-[1.6] text-[var(--color-ink)] shadow-[var(--shadow-elevated)] backdrop-blur-sm">
        <Metric
          label="fps"
          value={sample.fps.toFixed(0)}
          warn={sample.fps > 0 && sample.fps < FPS_WARN}
        />
        <Metric label="frame" value={`${sample.frameMs.toFixed(1)} ms`} />
        <Metric
          label="worst"
          value={`${sample.worstFrameMs.toFixed(0)} ms`}
          warn={sample.worstFrameMs > 100}
        />
        <Metric
          label="block"
          value={`${sample.mainThreadDelayMs.toFixed(0)} ms`}
          warn={sample.mainThreadDelayMs > DELAY_WARN_MS}
        />
        {sample.heapMb !== null && (
          <Metric label="heap" value={`${sample.heapMb.toFixed(0)} MB`} />
        )}
        <Metric label="ipc/s" value={sample.ipcPerSecond.toFixed(1)} />
        <Metric
          label="pending"
          value={String(sample.ipcPending)}
          warn={sample.ipcPending > 4}
        />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--color-hint)]">{label}</span>
      <span className={cn(warn && "text-[var(--color-accent)]")}>{value}</span>
    </div>
  );
}
