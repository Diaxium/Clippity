import { useState } from "react";
import { Loader2 } from "lucide-react";

import type { ReleaseChannel } from "@clippity/installer-shared";
import { Button } from "@shared/ui";
import { INSTALLED_VERSION } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

/** Maintenance step 2 — the online update check. */
export function CheckUpdatesStep() {
  const channel = useWizardStore((s) => s.channel);
  const setChannel = useWizardStore((s) => s.setChannel);
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);
  const markChecked = useWizardStore((s) => s.markCheckedForUpdates);

  const [checking, setChecking] = useState(false);

  const runCheck = () => {
    setChecking(true);
    // Contact the update server (simulated), then reveal the result.
    setTimeout(() => {
      markChecked();
      goToStep("update-available");
    }, 1400);
  };

  return (
    <StepShell
      title="Check for updates"
      subtitle="Clippity will check online for the latest available version."
      footer={
        <>
          <Button variant="secondary" onClick={back} disabled={checking}>
            Back
          </Button>
          <Button onClick={runCheck} disabled={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        </>
      }
    >
      <div className="pb-6">
        <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-4 divide-y divide-[var(--hairline)]">
          <InfoLine label="Installed version" value={`${INSTALLED_VERSION} (Stable)`} />
          <div className="flex items-center justify-between py-3">
            <span className="text-[13px] text-[var(--color-slate)]">
              Release channel
            </span>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as ReleaseChannel)}
              className="focus-ring rounded-[var(--radius-sm)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-2)] px-2.5 py-1.5 text-[13px] font-medium text-[var(--color-ink)]"
            >
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
              <option value="nightly">Nightly</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--color-overlay-1)] px-4 py-4">
          <Loader2
            size={20}
            strokeWidth={2}
            className={
              checking
                ? "animate-spin text-[var(--color-accent)]"
                : "text-[var(--color-hint)]"
            }
          />
          <div>
            <div className="text-[13px] font-medium text-[var(--color-ink)]">
              {checking ? "Checking for updates…" : "Ready to check"}
            </div>
            <div className="text-[12px] text-[var(--color-slate)]">
              {checking
                ? "Please wait while we contact the update server."
                : "Select a channel, then check for the latest version."}
            </div>
          </div>
        </div>
      </div>
    </StepShell>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="text-[13px] text-[var(--color-slate)]">{label}</span>
      <span className="text-[13px] font-medium text-[var(--color-ink)]">
        {value}
      </span>
    </div>
  );
}
