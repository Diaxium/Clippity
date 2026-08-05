/**
 * Command inspector — what crossed the IPC bridge, how long it took,
 * and how big it was.
 *
 * Reads the rolling window `services/tauri/client` fills at the invoke
 * boundary (see `shared/lib/ipcMetrics`), so it observes *every* call
 * the app makes rather than only the ones a feature remembered to
 * instrument. Recording is off until `developer.commandTiming` arms it,
 * which is what the empty state says.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { cn } from "@shared/lib/cn";
import { Button } from "@shared/ui";
import {
  clearIpcSamples,
  getIpcSamples,
  subscribeIpcMetrics,
  summarizeIpc,
  type IpcSample,
} from "@shared/lib/ipcMetrics";

import { formatBytes, formatMs } from "../lib/format";
import { CopyButton } from "./DevRow";

interface IpcInspectorProps {
  /** Whether recording is armed — `developer.commandTiming`. */
  enabled: boolean;
  /** Calls at or over this many ms are flagged. */
  slowMs: number;
}

export function IpcInspector({ enabled, slowMs }: IpcInspectorProps) {
  const samples = useSyncExternalStore(subscribeIpcMetrics, getIpcSamples);
  const summary = useMemo(
    () => summarizeIpc(samples, slowMs),
    [samples, slowMs]
  );
  // Newest first: the question is always about what just happened.
  const rows = useMemo(() => [...samples].reverse().slice(0, 60), [samples]);

  const copyText = useCallback(
    () =>
      [
        `IPC — ${summary.total} calls, ${summary.failed} failed, ${summary.slow} over ${slowMs} ms`,
        `avg ${formatMs(summary.avgMs)} · p95 ${formatMs(summary.p95Ms)}`,
        "",
        ...summary.byCommand.map(
          (c) =>
            `${c.command}: ${c.calls} calls, avg ${formatMs(c.avgMs)}, max ${formatMs(
              c.maxMs
            )}${c.failed > 0 ? `, ${c.failed} failed` : ""}`
        ),
      ].join("\n"),
    [summary, slowMs]
  );

  if (!enabled) {
    return (
      <p className="px-5 py-4 text-[12.5px] text-[var(--color-slate)]">
        Turn on <span className="font-medium">Record command timing</span> above
        to collect durations, payload sizes and failures for every IPC call.
        Nothing is recorded until you do.
      </p>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-[var(--color-slate)]">
        <span>
          <span className="font-mono text-[var(--color-ink)]">
            {summary.total}
          </span>{" "}
          calls
        </span>
        <span>
          avg{" "}
          <span className="font-mono text-[var(--color-ink)]">
            {formatMs(summary.avgMs)}
          </span>
        </span>
        <span>
          p95{" "}
          <span className="font-mono text-[var(--color-ink)]">
            {formatMs(summary.p95Ms)}
          </span>
        </span>
        <span>
          <span
            className={cn(
              "font-mono",
              summary.slow > 0
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-ink)]"
            )}
          >
            {summary.slow}
          </span>{" "}
          over {slowMs} ms
        </span>
        <span>
          <span
            className={cn(
              "font-mono",
              summary.failed > 0
                ? "text-[var(--color-accent)]"
                : "text-[var(--color-ink)]"
            )}
          >
            {summary.failed}
          </span>{" "}
          failed
        </span>
        <span className="ml-auto flex items-center gap-2">
          <CopyButton text={copyText} label="Copy report" />
          <Button variant="secondary" size="sm" onClick={clearIpcSamples}>
            Clear
          </Button>
        </span>
      </div>

      <div className="max-h-72 overflow-auto rounded-[var(--radius-md)] border border-[color:var(--hairline)]">
        <table className="w-full border-collapse text-left font-mono text-[11.5px]">
          <thead className="sticky top-0 bg-[var(--color-surface)] text-[var(--color-slate)]">
            <tr>
              <th className="px-2.5 py-1.5 font-medium">Command</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Duration</th>
              <th className="px-2.5 py-1.5 font-medium">Status</th>
              <th className="px-2.5 py-1.5 text-right font-medium">In</th>
              <th className="px-2.5 py-1.5 text-right font-medium">Out</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-2.5 py-3 text-[var(--color-hint)]"
                >
                  No calls recorded yet — use the app and they will appear here.
                </td>
              </tr>
            )}
            {rows.map((sample) => (
              <Row key={sample.seq} sample={sample} slowMs={slowMs} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ sample, slowMs }: { sample: IpcSample; slowMs: number }) {
  const slow = sample.ms >= slowMs;
  return (
    <tr className="border-t border-[color:var(--hairline)]">
      <td className="max-w-[16rem] truncate px-2.5 py-1.5 text-[var(--color-ink)]">
        {sample.command}
      </td>
      <td
        className={cn(
          "px-2.5 py-1.5 text-right",
          slow ? "text-[var(--color-accent)]" : "text-[var(--color-ink)]"
        )}
      >
        {formatMs(sample.ms)}
      </td>
      <td
        className={cn(
          "px-2.5 py-1.5",
          sample.ok ? "text-[var(--color-slate)]" : "text-[var(--color-accent)]"
        )}
      >
        {sample.ok ? (slow ? "Slow" : "OK") : (sample.code ?? "failed")}
      </td>
      <td className="px-2.5 py-1.5 text-right text-[var(--color-slate)]">
        {formatBytes(sample.requestBytes)}
      </td>
      <td className="px-2.5 py-1.5 text-right text-[var(--color-slate)]">
        {formatBytes(sample.responseBytes)}
      </td>
    </tr>
  );
}
