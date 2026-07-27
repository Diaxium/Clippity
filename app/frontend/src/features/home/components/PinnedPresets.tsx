/**
 * "Pinned presets" card — the first few saved capture presets. Clicking
 * a row runs the preset; "Manage" and "Add preset" jump to the Presets
 * view.
 */

import { AppWindow, Crop, Maximize, Plus, SquarePen } from "lucide-react";

import { runPreset, type CapturePreset } from "@services/tauri/clients/presets";
import type { CaptureType } from "@services/tauri/clients/capture";

import { tintForIndex } from "../types";
import { CardEmpty, IconTile, LinkAction, SectionCard, SectionHeading } from "./primitives";

const TYPE_ICON: Record<CaptureType, typeof Crop> = {
  region: Crop,
  window: AppWindow,
  fullscreen: Maximize,
  custom: SquarePen,
};

const TYPE_LABEL: Record<CaptureType, string> = {
  region: "Region",
  window: "Window",
  fullscreen: "Fullscreen",
  custom: "Custom",
};

interface PinnedPresetsProps {
  presets: CapturePreset[];
  loading: boolean;
  onManage: () => void;
  onAdd: () => void;
}

export function PinnedPresets({
  presets,
  loading,
  onManage,
  onAdd,
}: PinnedPresetsProps) {
  return (
    <SectionCard>
      <SectionHeading
        title="Pinned presets"
        action={<LinkAction label="Manage" onClick={onManage} />}
      />
      {presets.length === 0 ? (
        <CardEmpty>{loading ? "Loading…" : "No presets yet."}</CardEmpty>
      ) : (
        <ul className="mt-3 flex flex-1 flex-col gap-2.5">
          {presets.map((preset, i) => (
            <li key={preset.id}>
              <button
                type="button"
                onClick={() => void runPreset(preset)}
                title={`Run "${preset.name}"`}
                className="focus-ring flex w-full items-center gap-3 rounded-[10px] text-left transition-colors hover:bg-[var(--color-overlay-1)]"
              >
                <IconTile
                  icon={TYPE_ICON[preset.request.type]}
                  tint={tintForIndex(i)}
                  size={36}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]">
                    {preset.name}
                  </span>
                  <span className="block text-[12px] text-[var(--color-slate)]">
                    {TYPE_LABEL[preset.request.type]}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onAdd}
        className="focus-ring mt-4 flex h-9 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-[color:var(--hairline-strong)] text-[13px] font-medium text-[var(--color-slate)] transition-colors hover:border-[color:var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        <Plus size={15} strokeWidth={2} />
        Add preset
      </button>
    </SectionCard>
  );
}
