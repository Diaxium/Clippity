import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { ReleaseChannel } from "@clippity/installer-shared";
import { Button } from "@shared/ui";
import { INSTALLED_VERSION } from "@config/catalog";
import { UPDATE_INFO } from "@config/catalog";
import * as backend from "@services/installer";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

/** Maintenance step 2 — the online update check. */
export function CheckUpdatesStep() {
  const channel = useWizardStore((s) => s.channel);
  const setChannel = useWizardStore((s) => s.setChannel);
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);
  const setUpdateInfo = useWizardStore((s) => s.setUpdateInfo);

  const [checking, setChecking] = useState(false);
  const [installedVersion, setInstalledVersion] = useState(INSTALLED_VERSION);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    backend
      .getInstallStatus()
      .then((status) => {
        if (status) setInstalledVersion(status.installed.version);
      })
      .catch(() => {});
  }, []);

  const runCheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const info = (await backend.checkUpdates(channel)) ?? {
        ...UPDATE_INFO,
        installed: { version: installedVersion, channel },
        latest: { ...UPDATE_INFO.latest, channel },
      };
      setUpdateInfo(info);
      goToStep("update-available");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
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
          <Button onClick={() => void runCheck()} disabled={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        </>
      }
    >
      <div className="pb-6">
        <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-4 divide-y divide-[var(--hairline)]">
          <InfoLine label="Installed version" value={installedVersion} />
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

        {error ? (
          <div
            role="alert"
            className="mt-3 rounded-[var(--radius-md)] border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3.5 py-3 text-[12.5px] text-[var(--color-accent)]"
          >
            {error}
          </div>
        ) : null}

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
