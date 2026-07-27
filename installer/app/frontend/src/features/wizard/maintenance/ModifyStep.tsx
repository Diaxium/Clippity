import { useEffect } from "react";
import { FolderOpen } from "lucide-react";

import { Button, Checkbox } from "@shared/ui";
import { cn } from "@shared/lib/cn";
import { formatBytes } from "@shared/lib/format";
import { openBrowseDialog } from "@services/dialog";
import { COMPONENTS } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

/** Maintenance step 4 — change installed features + settings. */
export function ModifyStep() {
  const options = useWizardStore((s) => s.options);
  const setOptions = useWizardStore((s) => s.setOptions);
  const selected = useWizardStore((s) => s.selectedComponents);
  const toggleComponent = useWizardStore((s) => s.toggleComponent);
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);
  const startOperation = useWizardStore((s) => s.startOperation);
  const hydrateFromInstalled = useWizardStore((s) => s.hydrateFromInstalled);

  // Show what is actually installed, not the wizard's defaults: "Apply
  // changes" rewrites the manifest and the app's configuration from these
  // toggles, so a default-filled form would quietly undo the user's
  // original choices. Self-guarded to run once per wizard run.
  useEffect(() => {
    void hydrateFromInstalled();
  }, [hydrateFromInstalled]);

  const hasComponent = (id: string) => selected.includes(id);

  const spaceRequired = COMPONENTS.filter((c) => selected.includes(c.id)).reduce(
    (sum, c) => sum + c.sizeBytes,
    0
  );

  const apply = () => {
    goToStep("applying");
    startOperation("modify", "complete");
  };

  const browse = async () => {
    const picked = await openBrowseDialog(options.destination);
    if (picked) setOptions({ destination: picked });
  };

  return (
    <StepShell
      title="Modify your installation"
      subtitle="Choose which features and settings you want to install or change."
      footer={
        <>
          <Button variant="secondary" onClick={back}>
            Back
          </Button>
          <Button onClick={apply}>Apply changes</Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_220px] gap-3 pb-6">
        {/* Left: features & integrations */}
        <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-3.5">
          <div className="mb-2 text-[12px] font-semibold text-[var(--color-slate)]">
            Features &amp; integrations
          </div>
          <div className="flex flex-col">
            <CheckRow
              label="Create desktop shortcut"
              checked={options.createDesktopShortcut}
              onChange={(v) => setOptions({ createDesktopShortcut: v })}
            />
            <CheckRow
              label="Start Clippity at login"
              checked={options.startAtLogin}
              onChange={(v) => setOptions({ startAtLogin: v })}
            />
            <CheckRow
              label="Enable automatic updates"
              checked={options.automaticUpdates}
              onChange={(v) => setOptions({ automaticUpdates: v })}
            />
            <CheckRow
              label="Help improve Clippity (anonymous usage data)"
              checked={options.helpImprove}
              onChange={(v) => setOptions({ helpImprove: v })}
            />
            <CheckRow
              label="File associations (images, videos, GIFs)"
              checked={options.fileAssociations}
              onChange={(v) => setOptions({ fileAssociations: v })}
            />
            <CheckRow
              label="Capture integration (global hotkeys)"
              checked={hasComponent("capture")}
              onChange={() => toggleComponent("capture")}
            />
            <CheckRow
              label="OCR engine (on-device)"
              checked={hasComponent("ocr")}
              onChange={() => toggleComponent("ocr")}
            />
            {/* The app hides GIF recording when this is off, so leaving it
                out of Modify would make the choice one-way. */}
            <CheckRow
              label="GIF encoder"
              checked={hasComponent("gif")}
              onChange={() => toggleComponent("gif")}
            />
            <CheckRow
              label="Cloud sync"
              badge="Beta"
              checked={hasComponent("cloud")}
              onChange={() => toggleComponent("cloud")}
            />
          </div>
        </div>

        {/* Right: location + scope + space */}
        <div className="flex flex-col gap-3">
          <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-3.5">
            <div className="mb-1.5 text-[12px] font-semibold text-[var(--color-slate)]">
              Install location
            </div>
            <div className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--hairline)] bg-[var(--color-overlay-2)] px-2.5 py-2">
              <FolderOpen size={13} className="shrink-0 text-[var(--color-hint)]" />
              <span className="truncate text-[12px] text-[var(--color-ink)]">
                {options.destination}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1.5 w-full"
              onClick={() => void browse()}
            >
              Browse…
            </Button>
          </div>

          <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-3.5">
            <div className="mb-2 text-[12px] font-semibold text-[var(--color-slate)]">
              Install for
            </div>
            <RadioLine
              label="Current user (You)"
              active={options.scope === "current-user"}
              onClick={() => setOptions({ scope: "current-user" })}
            />
            <RadioLine
              label="All users on this computer"
              active={options.scope === "all-users"}
              onClick={() => setOptions({ scope: "all-users" })}
            />
          </div>

          <div className="rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--color-overlay-1)] px-3.5 py-2.5 text-[12px]">
            <div className="flex items-center justify-between py-1">
              <span className="text-[var(--color-slate)]">Space required</span>
              <span className="font-medium text-[var(--color-ink)]">
                {formatBytes(spaceRequired, { approx: true })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </StepShell>
  );
}

function CheckRow({
  label,
  badge,
  checked,
  onChange,
}: {
  label: string;
  badge?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-2">
      <Checkbox checked={checked} onChange={onChange} label={label} />
      <span className="flex items-center gap-1.5 text-[13px] text-[var(--color-ink)]">
        {label}
        {badge && (
          <span className="rounded-full bg-[var(--color-tile-violet)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-tile-violet-ink)]">
            {badge}
          </span>
        )}
      </span>
    </label>
  );
}

function RadioLine({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 py-1.5 text-left"
    >
      <span
        className={cn(
          "grid h-[16px] w-[16px] shrink-0 place-items-center rounded-full border transition-colors",
          active
            ? "border-[var(--color-accent)]"
            : "border-[var(--hairline-strong)]"
        )}
      >
        {active && (
          <span className="h-[8px] w-[8px] rounded-full bg-[var(--color-accent)]" />
        )}
      </span>
      <span className="text-[12.5px] text-[var(--color-ink)]">{label}</span>
    </button>
  );
}
