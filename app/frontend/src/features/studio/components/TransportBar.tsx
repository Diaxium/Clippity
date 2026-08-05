import {
  ChevronFirst,
  ChevronLast,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "@shared/lib/cn";

import { formatDuration, formatTimecode } from "../lib/time";
import { isTrimmed, rangeDurationMs } from "../lib/trim";
import { useStudioStore } from "../state/studioStore";

/**
 * Playback and trim controls.
 *
 * Everything on this bar is also a keyboard binding
 * (`useStudioKeybinds`), and both routes call the same store actions —
 * so a button and its shortcut cannot drift into doing different
 * things. The shortcut is named in each control's tooltip rather than
 * hidden in a help panel, because this is where someone is standing
 * when they'd want to learn it.
 */
export function TransportBar() {
  const info = useStudioStore((s) => s.info);
  const currentMs = useStudioStore((s) => s.currentMs);
  const playing = useStudioStore((s) => s.playing);
  const muted = useStudioStore((s) => s.muted);
  const volume = useStudioStore((s) => s.volume);
  const range = useStudioStore((s) => s.range);
  const seek = useStudioStore((s) => s.seek);
  const stepFrames = useStudioStore((s) => s.stepFrames);
  const setHandleToPlayhead = useStudioStore((s) => s.setHandleToPlayhead);
  const setPlaying = useStudioStore((s) => s.setPlaying);
  const setMuted = useStudioStore((s) => s.setMuted);
  const setVolume = useStudioStore((s) => s.setVolume);
  const resetRange = useStudioStore((s) => s.resetRange);

  if (!info) return null;

  const duration = info.durationMs;
  const trimmed = isTrimmed(range, duration);

  return (
    <div
      className="flex items-center gap-2 border-t px-6 py-3"
      style={{ borderColor: "var(--ed-hairline)" }}
    >
      {/* ---- playback ---- */}
      <IconButton
        icon={ChevronFirst}
        label="Go to trim start"
        hint="Home"
        onClick={() => seek(range.startMs)}
      />
      <IconButton
        icon={SkipBack}
        label="Previous frame"
        hint=", or ←"
        onClick={() => stepFrames(-1)}
      />
      <button
        type="button"
        onClick={() => setPlaying(!playing)}
        aria-label={playing ? "Pause" : "Play"}
        title={`${playing ? "Pause" : "Play"} (Space)`}
        className="focus-ring grid h-9 w-9 place-items-center rounded-full transition-colors"
        style={{
          background: "var(--ed-accent)",
          color: "var(--ed-on-accent)",
        }}
      >
        {playing ? (
          <Pause size={16} strokeWidth={2} fill="currentColor" />
        ) : (
          // Nudged right by a pixel: a triangle's optical centre sits
          // left of its bounding box, so a centred play glyph reads as
          // off-centre inside a circle.
          <Play
            size={16}
            strokeWidth={2}
            fill="currentColor"
            className="translate-x-[1px]"
          />
        )}
      </button>
      <IconButton
        icon={SkipForward}
        label="Next frame"
        hint=". or →"
        onClick={() => stepFrames(1)}
      />
      <IconButton
        icon={ChevronLast}
        label="Go to trim end"
        hint="End"
        onClick={() => seek(range.endMs)}
      />

      {/* ---- readout ---- */}
      <div className="ml-3 flex items-baseline gap-1.5 tabular-nums">
        <span
          className="text-[13px] font-medium"
          style={{ color: "var(--ed-text)" }}
        >
          {formatTimecode(currentMs)}
        </span>
        <span
          className="text-[11.5px]"
          style={{ color: "var(--ed-text-faint)" }}
        >
          / {formatTimecode(duration)}
        </span>
      </div>

      <div className="flex-1" />

      {/* ---- trim ---- */}
      <button
        type="button"
        onClick={() => setHandleToPlayhead("in")}
        title="Set trim start to the playhead (I)"
        className="focus-ring rounded-[7px] px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-[color:var(--ed-elev)]"
        style={{ color: "var(--ed-text-dim)" }}
      >
        Set in
      </button>
      <button
        type="button"
        onClick={() => setHandleToPlayhead("out")}
        title="Set trim end to the playhead (O)"
        className="focus-ring rounded-[7px] px-2.5 py-1.5 text-[12px] font-medium transition-colors hover:bg-[color:var(--ed-elev)]"
        style={{ color: "var(--ed-text-dim)" }}
      >
        Set out
      </button>

      {/* The selection's length, and a way back. Both only once there is
          something to report — an untrimmed clip's "length" is just the
          duration already shown in the readout. */}
      {trimmed ? (
        <>
          <span
            className="ml-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium tabular-nums"
            style={{
              background: "var(--ed-accent-soft)",
              color: "var(--ed-text)",
            }}
          >
            {formatDuration(rangeDurationMs(range))} selected
          </span>
          <IconButton
            icon={RotateCcw}
            label="Reset trim to the whole clip"
            onClick={resetRange}
          />
        </>
      ) : null}

      {/* ---- audio ---- */}
      {info.hasAudio ? (
        <div className="ml-2 flex items-center gap-1.5">
          <IconButton
            icon={muted || volume === 0 ? VolumeX : Volume2}
            label={muted ? "Unmute" : "Mute"}
            hint="M"
            onClick={() => setMuted(!muted)}
          />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Volume"
            className="clippity-slider w-20"
          />
        </div>
      ) : (
        // Stated rather than left blank: silence the user didn't expect
        // is the recorder's most common surprise (a denied microphone),
        // and this is where they come to check.
        <span
          className="ml-2 text-[11.5px]"
          style={{ color: "var(--ed-text-faint)" }}
        >
          No audio
        </span>
      )}
    </div>
  );
}

interface IconButtonProps {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  /** Keyboard equivalent, appended to the tooltip. */
  hint?: string;
  onClick: () => void;
  className?: string;
}

function IconButton({
  icon: Icon,
  label,
  hint,
  onClick,
  className,
}: IconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={hint ? `${label} (${hint})` : label}
      className={cn(
        "focus-ring grid h-8 w-8 place-items-center rounded-[8px] transition-colors hover:bg-[color:var(--ed-elev)]",
        className
      )}
      style={{ color: "var(--ed-text-dim)" }}
    >
      <Icon size={16} strokeWidth={1.9} />
    </button>
  );
}
