import { useState } from "react";
import { LayoutGrid, Plus } from "lucide-react";

import type { CapturePreset } from "@services/tauri/clients/presets";
import { usePresets } from "@shared/hooks/usePresets";
import { Button } from "@shared/ui";

import { PresetCard } from "./PresetCard";
import { PresetEditor } from "./PresetEditor";

/**
 * Presets manager. Lists saved presets, opens the create/edit modal, and
 * (per card) Run / Edit / Delete. The list mirrors
 * `clippity://presets/changed` via `usePresets`, so a create/edit/delete
 * reflects immediately here and in the tray.
 */
export function PresetsLayout() {
  const { presets, loading } = usePresets();
  const [editing, setEditing] = useState<CapturePreset | "new" | null>(null);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <div>
          <h1 className="text-[18px] font-semibold text-[var(--color-ink)]">
            Presets
          </h1>
          <p className="text-[13px] text-[var(--color-slate)]">
            One-click capture + output workflows. Run them from the tray.
          </p>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus size={16} strokeWidth={2.2} />
          New preset
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-6">
        {presets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-[color:var(--color-overlay-1)] text-[var(--color-hint)]">
              <LayoutGrid size={22} strokeWidth={1.8} />
            </span>
            <p className="text-[13px] text-[var(--color-slate)]">
              {loading ? "Loading…" : "No presets yet."}
            </p>
            {!loading && (
              <Button variant="secondary" onClick={() => setEditing("new")}>
                Create your first preset
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {presets.map((p) => (
              <PresetCard key={p.id} preset={p} onEdit={() => setEditing(p)} />
            ))}
          </div>
        )}
      </div>

      {editing && (
        <PresetEditor
          preset={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
