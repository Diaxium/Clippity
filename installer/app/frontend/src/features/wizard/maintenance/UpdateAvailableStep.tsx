import { ArrowRight, Check, HardDrive, Radio, ShieldCheck } from "lucide-react";

import { Button } from "@shared/ui";
import { formatBytes } from "@shared/lib/format";
import { UPDATE_INFO } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

/** Maintenance step 3 — the found update, its notes, and the CTA. */
export function UpdateAvailableStep() {
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);
  const startOperation = useWizardStore((s) => s.startOperation);

  const update = () => {
    goToStep("applying");
    startOperation("update", "complete");
  };

  const { installed, latest, downloadBytes, releaseNotes } = UPDATE_INFO;

  return (
    <StepShell
      title="Update available"
      subtitle="A new version of Clippity is ready to install."
      footer={
        <Button variant="secondary" onClick={back}>
          Back
        </Button>
      }
    >
      <div className="grid grid-cols-[1fr_200px] gap-3 pb-6">
        {/* Left: version + release notes */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-4 py-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--color-hint)]">
                Installed
              </div>
              <div className="text-[20px] font-semibold text-[var(--color-ink)]">
                {installed.version}
              </div>
              <div className="text-[11px] text-[var(--color-slate)]">Stable</div>
            </div>
            <ArrowRight size={18} className="text-[var(--color-hint)]" />
            <div>
              <div className="text-[11px] uppercase tracking-wide text-[var(--color-accent)]">
                Available
              </div>
              <div className="text-[20px] font-semibold text-[var(--color-accent)]">
                {latest.version}
              </div>
              <div className="text-[11px] text-[var(--color-slate)]">Stable</div>
            </div>
          </div>

          <div className="rounded-[var(--radius-lg)] border border-[var(--hairline)] bg-[var(--color-overlay-1)] px-4 py-3.5">
            <div className="mb-2 text-[13px] font-semibold text-[var(--color-ink)]">
              What&apos;s new in {latest.version}
            </div>
            <ul className="flex flex-col gap-1.5">
              {releaseNotes.map((note) => (
                <li key={note} className="flex items-start gap-2 text-[12.5px] text-[var(--color-slate)]">
                  <Check
                    size={13}
                    strokeWidth={2.4}
                    className="mt-0.5 shrink-0 text-[var(--color-accent)]"
                  />
                  {note}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="mt-3 text-[12px] font-medium text-[var(--color-accent)] hover:underline"
            >
              View full release notes →
            </button>
          </div>
        </div>

        {/* Right: meta + actions */}
        <div className="flex flex-col gap-3">
          <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-3.5">
            <MetaRow icon={HardDrive} label="Download size" value={formatBytes(downloadBytes)} />
            <MetaRow icon={ShieldCheck} label="Signature" value="Verified" accent />
            <MetaRow icon={Radio} label="Channel" value="Stable" />
          </div>

          <div className="flex flex-col gap-2">
            <Button onClick={update}>Update now</Button>
            <Button variant="secondary" onClick={update}>
              Update when Clippity closes
            </Button>
            <Button variant="ghost" onClick={back}>
              Remind me later
            </Button>
          </div>
        </div>
      </div>
    </StepShell>
  );
}

function MetaRow({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <Icon size={14} strokeWidth={1.8} className="shrink-0 text-[var(--color-hint)]" />
      <span className="flex-1 text-[11.5px] text-[var(--color-slate)]">{label}</span>
      <span
        className={
          accent
            ? "text-[12px] font-semibold text-[var(--color-success)]"
            : "text-[12px] font-medium text-[var(--color-ink)]"
        }
      >
        {value}
      </span>
    </div>
  );
}
