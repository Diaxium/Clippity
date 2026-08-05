import { useState } from "react";

import { DeveloperPanel, useRuntimeFlags } from "@features/developer";
import type { RuntimeFlags } from "@services/tauri/clients/developer";

import { CATEGORIES } from "../constants";
import { useSettings } from "../hooks/useSettings";
import { useSettingsPatch } from "../hooks/useSettingsPatch";
import type { Settings, SettingsCategory, SettingsPatch } from "../types";
import { AppearancePanel } from "./AppearancePanel";
import { CapturePanel } from "./CapturePanel";
import { RecordingPanel } from "./RecordingPanel";
import { CategoryNav } from "./CategoryNav";
import { ComingSoonPanel } from "./ComingSoonPanel";
import { GeneralPanel } from "./GeneralPanel";
import { ModelsPanel } from "./ModelsPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { PerformancePanel } from "./PerformancePanel";
import { ShortcutsPanel } from "./ShortcutsPanel";

/**
 * Root of the Settings dashboard view. Header + category nav rail +
 * scrollable panel area. Hydrates the settings store on mount via
 * `useSettings`; panel writes go through `useSettingsPatch` (which
 * mirrors optimistically + races-out stale server responses).
 */
export function SettingsLayout() {
  const settings = useSettings();
  const patch = useSettingsPatch();
  const [category, setCategory] = useState<SettingsCategory>("general");
  // Safe mode / a pinned log level / devtools availability are fixed for
  // the process, so they are fetched once here and handed down rather
  // than re-asked by the panel on every render.
  const runtimeFlags = useRuntimeFlags();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-[color:var(--hairline)] px-8 py-5">
        <h1 className="text-[22px] font-semibold text-[var(--color-ink)]">
          Settings
        </h1>
        <p className="mt-0.5 text-[13px] text-[var(--color-slate)]">
          Manage your preferences and app configuration
        </p>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <CategoryNav active={category} onPick={setCategory} />

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {!settings && <Skeleton />}
          {settings && isBuilt(category) && (
            <Panel
              category={category}
              settings={settings}
              onPatch={(p) => patch(p)}
              runtimeFlags={runtimeFlags}
            />
          )}
          {settings && !isBuilt(category) && (
            <ComingSoonPanel category={category} />
          )}
        </div>
      </div>
    </div>
  );
}

interface PanelProps {
  category: SettingsCategory;
  settings: Settings;
  onPatch: (patch: SettingsPatch) => void;
  runtimeFlags: RuntimeFlags | null;
}

function Panel({ category, settings, onPatch, runtimeFlags }: PanelProps) {
  switch (category) {
    case "general":
      return (
        <GeneralPanel
          value={settings.general}
          onChange={(general) => onPatch({ general })}
        />
      );
    case "appearance":
      return (
        <AppearancePanel
          value={settings.appearance}
          onChange={(appearance) => onPatch({ appearance })}
        />
      );
    case "notifications":
      return (
        <NotificationsPanel
          value={settings.notifications}
          onChange={(notifications) => onPatch({ notifications })}
        />
      );
    case "performance":
      return (
        <PerformancePanel
          value={settings.performance}
          onChange={(performance) => onPatch({ performance })}
        />
      );
    case "capture":
      return (
        <CapturePanel
          value={settings.capture}
          onChange={(capture) => onPatch({ capture })}
        />
      );
    case "recording":
      return (
        <RecordingPanel
          value={settings.recording}
          onChange={(recording) => onPatch({ recording })}
        />
      );
    case "shortcuts":
      return (
        <ShortcutsPanel
          value={settings.shortcuts}
          onChange={(shortcuts) => onPatch({ shortcuts })}
        />
      );
    case "models":
      return (
        <ModelsPanel
          value={settings.models}
          onChange={(models) => onPatch({ models })}
        />
      );
    case "advanced":
      return (
        <DeveloperPanel
          value={settings.developer}
          onChange={(developer) => onPatch({ developer })}
          flags={runtimeFlags}
        />
      );
    default:
      return <ComingSoonPanel category={category} />;
  }
}

function isBuilt(id: SettingsCategory): boolean {
  return CATEGORIES.find((c) => c.id === id)?.built ?? false;
}

function Skeleton() {
  return (
    <div className="grid h-full place-items-center">
      <p className="text-[12.5px] text-[var(--color-hint)]">
        Loading settings…
      </p>
    </div>
  );
}
