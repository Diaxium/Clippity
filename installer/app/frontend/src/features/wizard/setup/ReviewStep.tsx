import { useState } from "react";
import { Download, ShieldAlert } from "lucide-react";

import { Button } from "@shared/ui";
import { formatBytes } from "@shared/lib/format";
import { COMPONENTS, PRODUCT } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";
import * as backend from "@services/installer";

import { StepShell } from "../components/StepShell";

/** A label/value row in the review table. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-[13px] text-[var(--color-slate)]">{label}</span>
      <span className="text-[13px] font-medium text-[var(--color-ink)]">
        {value}
      </span>
    </div>
  );
}

/** Setup step 4 — confirm selections, then start the install. */
export function ReviewStep() {
  const options = useWizardStore((s) => s.options);
  const selected = useWizardStore((s) => s.selectedComponents);
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);
  const startOperation = useWizardStore((s) => s.startOperation);

  const [busy, setBusy] = useState(false);
  const [elevationError, setElevationError] = useState<string | null>(null);

  /**
   * Start the install, taking the elevated path only when the chosen
   * destination actually needs it.
   *
   * A writable destination installs right here with no UAC prompt. A
   * protected one hands the plan to an elevated copy of the installer,
   * which resumes at the Installing step — so the user answers the wizard
   * once either way. Declining the prompt leaves them on this step with
   * their selections intact, free to pick another folder.
   */
  const install = async () => {
    setBusy(true);
    setElevationError(null);
    try {
      const plan = await backend.resolvePlan(options, selected);

      if (plan && (await backend.planRequiresElevation(plan))) {
        // Hands off and closes this window; nothing after it runs.
        await backend.elevateAndInstall(plan);
        return;
      }

      goToStep("installing");
      void startOperation("install", "complete", plan ?? undefined);
    } catch (err) {
      setElevationError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const chosen = COMPONENTS.filter((c) => selected.includes(c.id));
  const componentBytes = chosen.reduce((sum, c) => sum + c.sizeBytes, 0);
  const estimatedDisk = Math.round(componentBytes * 1.36);

  const yn = (v: boolean) => (v ? "Yes" : "No");

  return (
    <StepShell
      title="Review your selections"
      subtitle="Please review the settings below before installing."
      footer={
        <>
          <Button variant="secondary" onClick={back} disabled={busy}>
            Back
          </Button>
          <Button onClick={install} disabled={busy}>
            {busy ? "Starting…" : "Install"}
            <Download size={15} strokeWidth={2} />
          </Button>
        </>
      }
    >
      <div className="pb-6">
        <div className="divide-y divide-[var(--hairline)]">
          <Row
            label="Version"
            value={`Clippity ${PRODUCT.version} (${PRODUCT.arch})`}
          />
          <Row label="Install location" value={options.destination} />
          <Row
            label="Install for"
            value={options.scope === "all-users" ? "All users" : "Current user"}
          />
          <Row label="Desktop shortcut" value={yn(options.createDesktopShortcut)} />
          <Row label="Start at login" value={yn(options.startAtLogin)} />
          <Row label="Automatic updates" value={yn(options.automaticUpdates)} />
          <Row label="Help improve Clippity" value={yn(options.helpImprove)} />
        </div>

        <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-4">
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-[var(--color-slate)]">
              Components
            </span>
            <span className="text-[13px] font-medium text-[var(--color-ink)]">
              {chosen.length} selected • {formatBytes(componentBytes)}
            </span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-[13px] text-[var(--color-slate)]">
              Estimated disk space
            </span>
            <span className="text-[13px] font-semibold text-[var(--color-accent)]">
              {formatBytes(estimatedDisk, { approx: true })}
            </span>
          </div>
        </div>

        {elevationError && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-4"
          >
            <ShieldAlert
              size={16}
              strokeWidth={2}
              className="mt-0.5 shrink-0 text-[var(--color-accent)]"
            />
            <div className="text-[13px] text-[var(--color-slate)]">
              {elevationError}
              <div className="mt-1">
                Choose a folder you can write to — such as one under your user
                profile — to install without administrator rights.
              </div>
            </div>
          </div>
        )}
      </div>
    </StepShell>
  );
}
