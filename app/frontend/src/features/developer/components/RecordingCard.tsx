/**
 * Recorder statistics — the live session while one is running, and what
 * the last one actually did once it has finished.
 *
 * Both halves matter and neither replaces the other: the live numbers
 * answer "is this recording going wrong right now", and the post-session
 * ones answer "why did that clip come out like that" — which is the
 * question people actually ask, minutes later, in Settings.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import {
  getRecorderDiagnostics,
  type RecorderDiagnostics,
} from "@services/tauri/clients/developer";
import { recordingStatus } from "@services/tauri/clients/recorder";
import type { RecorderStatus } from "@clippity/shared";
import { Button } from "@shared/ui";
import { SectionCard } from "@features/settings/components/SectionCard";

import {
  avgBitrateKbps,
  dropRatePct,
  formatBytes,
  formatDuration,
  formatRecorderTarget,
} from "../lib/format";
import { ActionRow, CopyButton, StatLine } from "./DevRow";

/** A drop rate past this is worth colouring: the frame rate is higher
 *  than the machine can encode, which is the one thing a user can act
 *  on (lower the rate, or the resolution). */
const DROP_WARN_PCT = 2;

/** How often the live half re-reads while a session is running. */
const LIVE_POLL_MS = 1000;

export function RecordingCard() {
  const [last, setLast] = useState<RecorderDiagnostics | null>(null);
  const [live, setLive] = useState<RecorderStatus | null>(null);

  const refresh = useCallback(() => {
    void getRecorderDiagnostics().then(setLast, () => setLast(null));
    void recordingStatus().then(setLive, () => setLive(null));
  }, []);

  useEffect(() => {
    refresh();
    const handle = setInterval(refresh, LIVE_POLL_MS);
    return () => clearInterval(handle);
  }, [refresh]);

  const recording = live !== null && live.state !== "idle";

  return (
    <SectionCard title="Recording diagnostics">
      <ActionRow
        label={recording ? "Session in progress" : "Recorder"}
        description={
          recording
            ? "Live counters from the running session."
            : "Statistics from the most recent session this launch."
        }
      >
        <CopyButton
          text={() => (last ? summarize(last) : "No recording this session.")}
          label="Copy report"
          disabled={!last}
        />
        <Button variant="secondary" size="sm" onClick={refresh}>
          <RefreshCw size={13} strokeWidth={2} />
          Refresh
        </Button>
      </ActionRow>

      {recording && live && (
        <div className="py-2">
          <StatLine label="State" value={live.state} />
          <StatLine label="Elapsed" value={formatDuration(live.elapsedMs)} />
          <StatLine
            label="Frames encoded"
            value={live.frames.toLocaleString()}
          />
          <StatLine
            label="Frames dropped"
            value={live.dropped.toLocaleString()}
            tone={live.dropped > 0 ? "warn" : "normal"}
          />
          <StatLine label="File so far" value={formatBytes(live.bytes)} />
        </div>
      )}

      {!last && !recording && (
        <p className="px-5 py-3 text-[12.5px] text-[var(--color-slate)]">
          Nothing has been recorded since Clippity started. Make a recording and
          its statistics appear here.
        </p>
      )}

      {last && (
        <div className="py-2">
          <p className="px-5 pt-1 pb-1 text-[12px] font-medium text-[var(--color-ink)]">
            Last session
          </p>
          <StatLine label="Output" value={formatRecorderTarget(last)} />
          <StatLine label="Outcome" value={last.outcome} />
          <StatLine label="Duration" value={formatDuration(last.durationMs)} />
          <StatLine
            label="Frames encoded"
            value={last.frames.toLocaleString()}
          />
          <StatLine
            label="Frames dropped"
            value={`${last.dropped.toLocaleString()} (${dropRatePct(last).toFixed(1)}%)`}
            tone={dropRatePct(last) >= DROP_WARN_PCT ? "warn" : "normal"}
          />
          <StatLine
            label="Effective frame rate"
            value={
              last.durationMs > 0
                ? `${((last.frames * 1000) / last.durationMs).toFixed(1)} fps of ${
                    last.targetFps
                  } requested`
                : "—"
            }
          />
          <StatLine label="File size" value={formatBytes(last.bytes)} />
          <StatLine
            label="Average bitrate"
            value={
              avgBitrateKbps(last)
                ? `${(avgBitrateKbps(last) as number).toLocaleString()} kbit/s`
                : "—"
            }
          />
          <StatLine
            label="Audio track"
            value={last.hadAudio ? "written" : "none"}
          />
          <StatLine
            label="Encoder preference"
            value={
              last.preferredHardware ? "hardware, if available" : "software"
            }
          />
        </div>
      )}
    </SectionCard>
  );
}

/** The copyable block — the same numbers, as text for a bug report. */
function summarize(d: RecorderDiagnostics): string {
  const bitrate = avgBitrateKbps(d);
  return [
    "Clippity recording report",
    `- Output: ${formatRecorderTarget(d)}`,
    `- Outcome: ${d.outcome}`,
    `- Duration: ${formatDuration(d.durationMs)}`,
    `- Frames: ${d.frames} encoded, ${d.dropped} dropped (${dropRatePct(d).toFixed(1)}%)`,
    `- File: ${formatBytes(d.bytes)}${
      bitrate ? ` (${bitrate.toLocaleString()} kbit/s)` : ""
    }`,
    `- Audio: ${d.hadAudio ? "written" : "none"}`,
    `- Encoder: ${d.preferredHardware ? "hardware preferred" : "software"}`,
  ].join("\n");
}
