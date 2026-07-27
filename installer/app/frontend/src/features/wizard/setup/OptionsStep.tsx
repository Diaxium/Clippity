import type { ReactNode } from "react";
import {
  FolderOpen,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  MonitorCheck,
} from "lucide-react";

import { Button, ToggleSwitch } from "@shared/ui";
import { cn } from "@shared/lib/cn";
import { openBrowseDialog } from "@services/dialog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

/**
 * Roots a standard user can't write to — mirrors Rust
 * `installer_domain::install` PROTECTED_ROOTS. Installing under any of these
 * needs administrator approval, so the wizard can say so up front instead of
 * only surfacing it as an error on the Review step.
 */
const PROTECTED_ROOTS = [
  "c:\\program files (x86)",
  "c:\\program files",
  "c:\\programdata",
  "c:\\windows",
];

/** Whether `dest` sits under a protected root (case/separator-insensitive). */
function destinationNeedsAdmin(dest: string): boolean {
  const normalized = dest.replace(/\//g, "\\").toLowerCase();
  return PROTECTED_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(root + "\\")
  );
}

/** A labeled toggle row: leading icon, title + hint, trailing switch. */
function ToggleRow({
  icon,
  title,
  hint,
  checked,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-md)] px-1 py-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] bg-[var(--color-overlay-2)] text-[var(--color-slate)]">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-[var(--color-ink)]">
          {title}
        </div>
        <div className="text-[12px] text-[var(--color-slate)]">{hint}</div>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} label={title} />
    </div>
  );
}

/** Setup step 2 — install destination + the toggleable behaviors. */
export function OptionsStep() {
  const options = useWizardStore((s) => s.options);
  const setOptions = useWizardStore((s) => s.setOptions);
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);

  const browse = async () => {
    const picked = await openBrowseDialog(options.destination);
    if (picked) setOptions({ destination: picked });
  };

  const needsAdmin =
    options.scope === "all-users" || destinationNeedsAdmin(options.destination);

  return (
    <StepShell
      title="Installation options"
      subtitle="Customize how Clippity is installed and configured."
      footer={
        <>
          <Button variant="secondary" onClick={back}>
            Back
          </Button>
          <Button onClick={() => goToStep("components")}>Next</Button>
        </>
      }
    >
      <div className="pb-6">
        {/* Destination */}
        <label className="mb-1.5 block text-[12px] font-medium text-[var(--color-slate)]">
          Destination folder
        </label>
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-3 py-2.5">
            <FolderOpen
              size={15}
              strokeWidth={1.8}
              className="shrink-0 text-[var(--color-hint)]"
            />
            <span className="truncate text-[13px] text-[var(--color-ink)]">
              {options.destination}
            </span>
          </div>
          <Button variant="secondary" onClick={() => void browse()}>
            Browse…
          </Button>
        </div>

        {needsAdmin && (
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--color-slate)]">
            <ShieldAlert
              size={13}
              strokeWidth={1.9}
              className="shrink-0 text-[var(--color-accent)]"
            />
            {options.scope === "all-users"
              ? "Installing for all users needs administrator approval."
              : "This location needs administrator approval. Choose a folder under your user profile to install without it."}
          </div>
        )}

        {/* Toggles */}
        <div className="mt-4 flex flex-col divide-y divide-[var(--hairline)]">
          <ToggleRow
            icon={<MonitorCheck size={16} strokeWidth={1.8} />}
            title="Create desktop shortcut"
            hint="Add a shortcut on the desktop"
            checked={options.createDesktopShortcut}
            onChange={(v) => setOptions({ createDesktopShortcut: v })}
          />
          <ToggleRow
            icon={<Rocket size={16} strokeWidth={1.8} />}
            title="Start Clippity at login"
            hint="Launch Clippity automatically when you sign in"
            checked={options.startAtLogin}
            onChange={(v) => setOptions({ startAtLogin: v })}
          />
          <ToggleRow
            icon={<RefreshCw size={16} strokeWidth={1.8} />}
            title="Automatic updates"
            hint="Keep Clippity up to date automatically"
            checked={options.automaticUpdates}
            onChange={(v) => setOptions({ automaticUpdates: v })}
          />
          <ToggleRow
            icon={<ShieldCheck size={16} strokeWidth={1.8} />}
            title="Help improve Clippity"
            hint="Share anonymous usage data and diagnostics"
            checked={options.helpImprove}
            onChange={(v) => setOptions({ helpImprove: v })}
          />
        </div>

        {/* Install scope */}
        <div className="mt-4">
          <div className="mb-2 text-[12px] font-medium text-[var(--color-slate)]">
            Install for
          </div>
          <div className="grid grid-cols-2 gap-2">
            <ScopeOption
              active={options.scope === "current-user"}
              title="Current user (You)"
              hint="No admin required"
              onClick={() => setOptions({ scope: "current-user" })}
            />
            <ScopeOption
              active={options.scope === "all-users"}
              title="All users"
              hint="Requires administrator"
              onClick={() => setOptions({ scope: "all-users" })}
            />
          </div>
        </div>
      </div>
    </StepShell>
  );
}

function ScopeOption({
  active,
  title,
  hint,
  onClick,
}: {
  active: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors",
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
          : "border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] hover:bg-[var(--color-overlay-2)]"
      )}
    >
      <span
        className={cn(
          "text-[13px] font-medium",
          active ? "text-[var(--color-accent)]" : "text-[var(--color-ink)]"
        )}
      >
        {title}
      </span>
      <span className="text-[11.5px] text-[var(--color-slate)]">{hint}</span>
    </button>
  );
}
