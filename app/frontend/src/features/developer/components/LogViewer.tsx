/**
 * Live log viewer — the tail of the on-disk log, refreshed on a timer,
 * filterable by level and by text.
 *
 * Polled rather than streamed: an event per log line would mean the act
 * of watching the log generates log traffic (every emit crosses IPC),
 * and the failure being investigated is frequently "the app is busy".
 * A bounded read every second and a half costs one command and shows
 * the same thing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";

import { tailLog, type LogLine } from "@services/tauri/clients/developer";
import { cn } from "@shared/lib/cn";
import { Button, Select } from "@shared/ui";
import { LOG_POLL_MS, LOG_VIEW_LINES } from "@features/settings/constants";

import { CopyButton } from "./DevRow";

/** Level filter choices. `all` is the default; the rest are floors. */
const LEVEL_FILTERS = [
  { value: "all", label: "All levels" },
  { value: "error", label: "Errors" },
  { value: "warn", label: "Warnings and up" },
  { value: "info", label: "Info and up" },
  { value: "debug", label: "Debug and up" },
] as const;

const RANK: Record<string, number> = {
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
};

const LEVEL_CLASS: Record<string, string> = {
  error: "text-[var(--color-accent)]",
  warn: "text-[var(--color-accent)]",
  info: "text-[var(--color-slate)]",
  debug: "text-[var(--color-hint)]",
  trace: "text-[var(--color-hint)]",
};

/**
 * Pure: apply the level floor and the text query.
 *
 * A line with no level (a panic backtrace, a wrapped field) always
 * passes the level filter — those are the lines a crash produces, and
 * filtering them out would hide exactly what the viewer exists for.
 */
export function filterLines(
  lines: readonly LogLine[],
  level: string,
  query: string
): LogLine[] {
  const floor = level === "all" ? 0 : (RANK[level] ?? 0);
  const needle = query.trim().toLowerCase();
  return lines.filter((line) => {
    if (floor > 0 && line.level) {
      if ((RANK[line.level] ?? 0) < floor) return false;
    }
    if (!needle) return true;
    return (
      line.message.toLowerCase().includes(needle) || line.level.includes(needle)
    );
  });
}

export function LogViewer() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [level, setLevel] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    void tailLog(LOG_VIEW_LINES).then(
      (next) => {
        setLines(next);
        setError(null);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      }
    );
  }, []);

  useEffect(() => {
    refresh();
    if (!following) return;
    const handle = setInterval(refresh, LOG_POLL_MS);
    return () => clearInterval(handle);
  }, [refresh, following]);

  const visible = useMemo(
    () => filterLines(lines, level, query),
    [lines, level, query]
  );

  // Stick to the bottom while following — but only when following, so a
  // user reading back through the buffer isn't yanked forward.
  useEffect(() => {
    if (!following) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, following]);

  const copyText = useCallback(
    () =>
      visible
        .map((l) =>
          [l.timestamp, l.level.toUpperCase(), l.message]
            .filter(Boolean)
            .join(" ")
        )
        .join("\n"),
    [visible]
  );

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          value={level}
          options={LEVEL_FILTERS}
          onChange={setLevel}
          ariaLabel="Filter log by level"
          triggerClassName="h-7 min-w-[9.5rem] text-[12px]"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          aria-label="Filter log lines"
          className="focus-ring h-7 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-2 text-[12px] text-[var(--color-ink)] placeholder:text-[var(--color-hint)]"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setFollowing((f) => !f)}
          aria-pressed={following}
        >
          {following ? (
            <Pause size={13} strokeWidth={2} />
          ) : (
            <Play size={13} strokeWidth={2} />
          )}
          {following ? "Following" : "Paused"}
        </Button>
        <Button variant="secondary" size="sm" onClick={refresh}>
          <RefreshCw size={13} strokeWidth={2} />
          Refresh
        </Button>
        <CopyButton text={copyText} label="Copy shown" />
      </div>

      <div
        ref={scroller}
        className="h-72 overflow-auto rounded-[var(--radius-md)] border border-[color:var(--hairline)] bg-[color:var(--color-overlay-1)] p-2 font-mono text-[11.5px] leading-[1.55]"
      >
        {error && (
          <p className="text-[var(--color-accent)]">
            The log could not be read: {error}
          </p>
        )}
        {!error && visible.length === 0 && (
          <p className="text-[var(--color-hint)]">
            {lines.length === 0
              ? "Nothing logged yet. Disk logging must be on for the file to exist."
              : "No lines match this filter."}
          </p>
        )}
        {visible.map((line) => (
          <div
            key={line.seq}
            className="flex gap-2 whitespace-pre-wrap break-words"
          >
            {line.timestamp && (
              <span className="shrink-0 text-[var(--color-hint)]">
                {line.timestamp.slice(11, 23)}
              </span>
            )}
            {line.level && (
              <span
                className={cn(
                  "shrink-0 uppercase",
                  LEVEL_CLASS[line.level] ?? "text-[var(--color-slate)]"
                )}
              >
                {line.level}
              </span>
            )}
            <span className="min-w-0 text-[var(--color-ink)]">
              {line.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
