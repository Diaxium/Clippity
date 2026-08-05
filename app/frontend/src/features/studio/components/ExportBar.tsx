import { useState } from "react";

import { Check, Download, FolderOpen, X } from "lucide-react";

import type { RecorderFormat } from "@clippity/shared";
import { shareCapture } from "@services/tauri/clients/share";
import { cn } from "@shared/lib/cn";

import { useTrimExport } from "../hooks/useTrimExport";
import { formatDuration } from "../lib/time";
import { rangeDurationMs } from "../lib/trim";
import { useStudioStore } from "../state/studioStore";

/** How long a GIF may be, mirroring `domain::recorder::GIF_MAX_DURATION_MS`.
 *  Known here so the format can be *disabled with a reason* rather than
 *  accepted and then refused by the backend after the user commits. */
const GIF_MAX_MS = 60_000;

/**
 * The export row: pick a format, encode the selected range, and say
 * where the result went.
 *
 * Sits below the transport rather than inside it because it is the one
 * control on this surface that *writes* something. Everything above it
 * is reversible by moving a handle; this makes a file.
 */
export function ExportBar() {
  const info = useStudioStore((s) => s.info);
  const range = useStudioStore((s) => s.range);
  const [format, setFormat] = useState<RecorderFormat>("mp4");
  const [mute, setMute] = useState(false);
  const { progress, done, error, running, start, cancel } = useTrimExport();

  if (!info) return null;

  const selectedMs = rangeDurationMs(range);
  // GIF's ceiling is a property of the format, not of this clip, so the
  // control explains it up front instead of failing at the end of an
  // encode the user already waited for.
  const gifTooLong = selectedMs > GIF_MAX_MS;
  const blocked = format === "gif" && gifTooLong;

  return (
    <div
      className="flex items-center gap-3 border-t px-6 py-3"
      style={{ borderColor: "var(--ed-hairline)" }}
    >
      <div
        className="flex items-center gap-1 rounded-[9px] p-0.5"
        style={{ background: "var(--ed-control-bg)" }}
      >
        {(["mp4", "gif"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFormat(option)}
            disabled={running}
            aria-pressed={format === option}
            title={
              option === "gif" && gifTooLong
                ? `A GIF can be at most ${GIF_MAX_MS / 1000} seconds — shorten the selection`
                : undefined
            }
            className={cn(
              "focus-ring rounded-[7px] px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50",
              format === option ? "" : "hover:bg-[color:var(--ed-elev)]"
            )}
            style={
              format === option
                ? {
                    background: "var(--ed-active-bg)",
                    color: "var(--ed-active-text)",
                  }
                : { color: "var(--ed-text-dim)" }
            }
          >
            {option.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Audio is only a choice when there is audio and a track to put
          it in — offering a mute toggle for a GIF would imply the
          format could carry sound. */}
      {info.hasAudio && format === "mp4" ? (
        <label
          className="flex cursor-pointer items-center gap-1.5 text-[12px]"
          style={{ color: "var(--ed-text-dim)" }}
        >
          <input
            type="checkbox"
            checked={mute}
            disabled={running}
            onChange={(e) => setMute(e.target.checked)}
          />
          Remove audio
        </label>
      ) : null}

      <div className="flex-1" />

      {/* One slot, four states: idle, running, failed, done. They never
          appear together, so they share the space rather than making the
          bar grow and shift as an export progresses. */}
      {error ? (
        <span className="text-[12px]" style={{ color: "var(--ed-danger)" }}>
          {error}
        </span>
      ) : done ? (
        <>
          <span
            className="flex items-center gap-1.5 text-[12px]"
            style={{ color: "var(--ed-text-dim)" }}
          >
            <Check size={14} strokeWidth={2} />
            Exported {formatDuration(done.durationMs)} to your library
          </span>
          <button
            type="button"
            onClick={() =>
              void shareCapture(done.path, "reveal").catch(() => {})
            }
            className="focus-ring inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-[color:var(--ed-elev)]"
            style={{ color: "var(--ed-text)" }}
          >
            <FolderOpen size={14} strokeWidth={1.9} />
            Reveal
          </button>
        </>
      ) : running && progress ? (
        <>
          <div
            className="h-1.5 w-40 overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Export progress"
            aria-valuemin={0}
            aria-valuemax={progress.totalMs}
            aria-valuenow={progress.encodedMs}
            style={{ background: "var(--ed-control-bg)" }}
          >
            <div
              className="h-full rounded-full transition-[width] duration-150"
              style={{
                width: `${
                  progress.totalMs > 0
                    ? Math.min(
                        (progress.encodedMs / progress.totalMs) * 100,
                        100
                      )
                    : 0
                }%`,
                background: "var(--ed-accent)",
              }}
            />
          </div>
          <button
            type="button"
            onClick={cancel}
            className="focus-ring inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-[color:var(--ed-elev)]"
            style={{ color: "var(--ed-text-dim)" }}
          >
            <X size={14} strokeWidth={1.9} />
            Cancel
          </button>
        </>
      ) : null}

      <button
        type="button"
        onClick={() => start(format, mute)}
        disabled={running || blocked}
        title={
          blocked
            ? `A GIF can be at most ${GIF_MAX_MS / 1000} seconds — shorten the selection`
            : undefined
        }
        className="focus-ring inline-flex items-center gap-2 rounded-[9px] px-3.5 py-2 text-[12.5px] font-medium transition-opacity disabled:opacity-50"
        style={{ background: "var(--ed-accent)", color: "var(--ed-on-accent)" }}
      >
        <Download size={15} strokeWidth={2} />
        {running ? "Exporting…" : `Export ${formatDuration(selectedMs)}`}
      </button>
    </div>
  );
}
