import { Film, Pencil, Play, Repeat, Trash2 } from "lucide-react";

import {
  isRecordingPreset,
  presetsDelete,
  runPreset,
  type CapturePreset,
} from "@services/tauri/clients/presets";
import { captureTypeMeta } from "@shared/lib/captureTypeMeta";

interface PresetCardProps {
  preset: CapturePreset;
  onEdit: () => void;
}

/**
 * The chips under a preset's name: what it will do that isn't already
 * said by the icon and the type line.
 *
 * A recording lists what changes the *file* (format, rate, resolution,
 * audio); a screenshot lists its output steps. They barely overlap,
 * which is why this branches rather than trying to describe both with
 * one list.
 */
function summaryChips(p: CapturePreset): string[] {
  const chips: string[] = [];
  if (isRecordingPreset(p.request)) {
    const r = p.request;
    if (r.fps) chips.push(`${r.fps} fps`);
    if (r.maxHeight) chips.push(`${r.maxHeight}p`);
    if (r.audio?.microphone) chips.push("Mic");
    if (r.audio?.system) chips.push("System audio");
    if (r.toggles?.cursor) chips.push("Cursor");
    if (r.toggles?.clipboard) chips.push("Clipboard");
    if (p.output.saveDir) chips.push("Custom folder");
    return chips;
  }
  if (p.request.toggles.clipboard) chips.push("Clipboard");
  if (p.request.toggles.cursor) chips.push("Cursor");
  if (p.output.openEditor) chips.push("Open editor");
  if (p.output.saveDir) chips.push("Custom folder");
  return chips;
}

/**
 * One preset in the manager grid: type icon + name, a summary of what it
 * does, and Run / Edit / Delete. Run reuses the shared `runPreset`
 * orchestrator (same path the tray uses), which branches on the request
 * shape — so this component never has to know how a recording starts.
 */
export function PresetCard({ preset, onEdit }: PresetCardProps) {
  const request = preset.request;
  const recording = isRecordingPreset(request) ? request : null;
  const meta = captureTypeMeta(
    isRecordingPreset(request) ? request.target : request.type
  );
  // The format icon carries more information than the target icon for a
  // recording: "this makes a GIF" is the thing that changes what you
  // get, and the target is already spelled out on the line below.
  const Icon = recording
    ? recording.format === "gif"
      ? Repeat
      : Film
    : meta.icon;
  const chips = summaryChips(preset);
  const typeLine = recording
    ? `${recording.format === "gif" ? "GIF" : "Video"} · ${meta.label}`
    : meta.label;

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[var(--color-tile-cool)] text-[var(--color-tile-cool-ink)]">
          <Icon size={19} strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-[var(--color-ink)]">
            {preset.name}
          </div>
          <div className="text-[12px] text-[var(--color-slate)]">
            {typeLine}
          </div>
        </div>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((c) => (
            <span
              key={c}
              className="rounded-full bg-[color:var(--color-overlay-1)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-hint)]"
            >
              {c}
            </span>
          ))}
        </div>
      )}

      <div className="mt-1 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void runPreset(preset)}
          className="focus-ring inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] text-[12px] font-medium text-[var(--color-accent-ink)] transition-colors hover:bg-[var(--color-accent-hover)]"
        >
          <Play size={13} strokeWidth={2.2} />
          Run
        </button>
        <button
          type="button"
          aria-label="Edit preset"
          title="Edit"
          onClick={onEdit}
          className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-[var(--color-hint)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
        >
          <Pencil size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label="Delete preset"
          title="Delete"
          onClick={() => void presetsDelete(preset.id)}
          className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-[var(--color-hint)] transition-colors hover:bg-[color:var(--color-accent-soft)] hover:text-[var(--color-accent)]"
        >
          <Trash2 size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
