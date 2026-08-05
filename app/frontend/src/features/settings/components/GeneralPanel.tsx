import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { ToggleSwitch } from "@shared/ui";
import { useCapabilities } from "@state/useCapabilities";

import type { GeneralSettings } from "../types";
import { CapturesDirField } from "./CapturesDirField";
import { NameTemplateField } from "./NameTemplateField";
import { Row } from "./Row";
import { SectionCard } from "./SectionCard";

interface GeneralPanelProps {
  value: GeneralSettings;
  onChange(next: GeneralSettings): void;
}

const FALLBACK_HINT = "Default — <app data>/captures";

export function GeneralPanel({ value, onChange }: GeneralPanelProps) {
  const capabilities = useCapabilities();

  const browse = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: value.capturesDir || undefined,
      });
      if (typeof picked === "string")
        onChange({ ...value, capturesDir: picked });
    } catch {
      // Dialog cancelled or plugin unavailable — no-op.
    }
  };

  return (
    <>
      <SectionCard title="Captures">
        <Row
          label="Captures folder"
          description="Where new captures are saved. Leave blank to use the default location."
          control={
            <CapturesDirField
              value={value.capturesDir}
              fallbackHint={FALLBACK_HINT}
              onChange={(capturesDir) => onChange({ ...value, capturesDir })}
              onBrowse={browse}
            />
          }
        />
        <Row
          label="File name pattern"
          description="How new capture files are named, so they're easy to recognize. Leave blank to use the default."
          control={
            <NameTemplateField
              value={value.nameTemplate}
              onChange={(nameTemplate) => onChange({ ...value, nameTemplate })}
            />
          }
        />
      </SectionCard>

      <SectionCard title="Startup">
        {capabilities.startAtLogin ? (
          <Row
            label="Start Clippity on system startup"
            description="Your choice is saved now — automatic startup itself arrives in an upcoming release."
            control={
              <ToggleSwitch
                checked={value.startOnStartup}
                onChange={(next) =>
                  onChange({ ...value, startOnStartup: next })
                }
                label="Start on startup"
              />
            }
          />
        ) : (
          // The startup helper wasn't installed, so there is nothing behind
          // this switch. Explained rather than hidden: the row is where a
          // user goes looking for it, and the remedy is a Modify away.
          <Row
            label="Start Clippity on system startup"
            description="The startup helper wasn't selected when Clippity was installed. Re-run the installer and choose Modify to add it."
            control={
              <ToggleSwitch
                checked={false}
                disabled
                onChange={() => {}}
                label="Start on startup"
              />
            }
          />
        )}
      </SectionCard>

      <SectionCard title="Updates & privacy">
        <Row
          label="Automatic updates"
          description="Carried over from your installer choice. Your preference is saved now — automatic updating itself arrives in an upcoming release."
          control={
            <ToggleSwitch
              checked={value.automaticUpdates}
              onChange={(next) =>
                onChange({ ...value, automaticUpdates: next })
              }
              label="Automatic updates"
            />
          }
        />
        <Row
          label="Help improve Clippity"
          description="Carried over from your installer choice. Clippity sends nothing today — this records your answer for if and when it can."
          control={
            <ToggleSwitch
              checked={value.helpImprove}
              onChange={(next) => onChange({ ...value, helpImprove: next })}
              label="Help improve Clippity"
            />
          }
        />
      </SectionCard>
    </>
  );
}
