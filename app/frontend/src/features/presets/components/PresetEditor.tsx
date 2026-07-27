import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, X } from "lucide-react";

import {
  presetsCreate,
  presetsUpdate,
  type CapturePreset,
} from "@services/tauri/clients/presets";
import {
  CAPTURE_TYPE_META,
  type PresetCaptureType,
} from "@shared/lib/captureTypeMeta";
import { Button, ToggleSwitch } from "@shared/ui";
import { cn } from "@shared/lib/cn";

import { draftToInput, usePresetDraft } from "../hooks/usePresetDraft";

const TYPES: readonly PresetCaptureType[] = ["fullscreen", "region", "window"];

interface PresetEditorProps {
  /** Present = edit that preset; absent = create a new one. */
  preset?: CapturePreset;
  onClose: () => void;
}

/**
 * Create / edit modal, overlaid on the Presets view. Fields map to the
 * preset's capture config (type + clipboard/cursor) and output steps
 * (open-editor + save-dir). The folder picker reuses
 * `@tauri-apps/plugin-dialog` (same as the settings Storage field).
 */
export function PresetEditor({ preset, onClose }: PresetEditorProps) {
  const { draft, set, valid } = usePresetDraft(preset);
  const [saving, setSaving] = useState(false);

  // Standard dialog dismissal — Escape closes, even while the name
  // input has focus (it autoFocuses, so this is the common case).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const input = draftToInput(draft);
      if (preset) await presetsUpdate({ id: preset.id, ...input });
      else await presetsCreate(input);
      onClose();
    } catch {
      // Backend rejection is unlikely (we gate on a non-empty name);
      // keep the form open so the user can retry.
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") set("saveDir", picked);
    } catch {
      /* not in a Tauri context / dialog dismissed */
    }
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-[color:var(--color-overlay-4)] p-6"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[420px] flex-col gap-4 rounded-[16px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-modal)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--color-ink)]">
            {preset ? "Edit preset" : "New preset"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="focus-ring grid h-7 w-7 place-items-center rounded-lg text-[var(--color-hint)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-[var(--color-slate)]">
            Name
          </span>
          <input
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Region to clipboard"
            autoFocus
            className="focus-ring h-9 rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface-2)] px-3 text-[13px] text-[var(--color-ink)] placeholder:text-[var(--color-hint)]"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-[var(--color-slate)]">
            Capture type
          </span>
          <div className="grid grid-cols-3 gap-1.5">
            {TYPES.map((t) => {
              const meta = CAPTURE_TYPE_META[t];
              const Icon = meta.icon;
              const active = draft.type === t;
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={active}
                  onClick={() => set("type", t)}
                  className={cn(
                    "focus-ring flex flex-col items-center gap-1 rounded-[10px] border p-2.5 text-[12px] font-medium transition-colors",
                    active
                      ? "border-[color:var(--color-accent)]/45 bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
                      : "border-[color:var(--hairline)] bg-[var(--color-surface-2)] text-[var(--color-slate)] hover:text-[var(--color-ink)]"
                  )}
                >
                  <Icon size={17} strokeWidth={1.9} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Copy to clipboard"
            checked={draft.clipboard}
            onChange={(v) => set("clipboard", v)}
          />
          <ToggleRow
            label="Include cursor"
            checked={draft.cursor}
            onChange={(v) => set("cursor", v)}
          />
          <ToggleRow
            label="Open in editor after capture"
            checked={draft.openEditor}
            onChange={(v) => set("openEditor", v)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-[var(--color-slate)]">
            Save to
          </span>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink)]">
              {draft.saveDir ?? "Default captures folder"}
            </span>
            {draft.saveDir && (
              <button
                type="button"
                onClick={() => set("saveDir", null)}
                className="focus-ring rounded-lg px-2 py-1 text-[12px] text-[var(--color-hint)] transition-colors hover:text-[var(--color-ink)]"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => void pickFolder()}
              className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-overlay-2)] px-2.5 py-1 text-[12px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[color:var(--color-overlay-3)]"
            >
              <FolderOpen size={13} strokeWidth={2} />
              Choose…
            </button>
          </div>
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!valid || saving}>
            {preset ? "Save changes" : "Create preset"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-[var(--color-ink)]">{label}</span>
      <ToggleSwitch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}
