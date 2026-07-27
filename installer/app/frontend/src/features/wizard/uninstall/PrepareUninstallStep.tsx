import {
  AppWindow,
  FolderGit2,
  Image as ImageIcon,
  KeyRound,
  Link2,
  Settings,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@shared/ui";
import type { IconComponent } from "@shared/lib/icon";
import { formatBytes } from "@shared/lib/format";
import { DATA_CATEGORIES } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

const ICON: Record<string, IconComponent> = {
  app: AppWindow,
  shortcuts: Link2,
  cache: ImageIcon,
  settings: Settings,
  credentials: KeyRound,
  content: FolderGit2,
};

/** Uninstall step 2 — the storage summary before choosing what to remove. */
export function PrepareUninstallStep() {
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);

  return (
    <StepShell
      title="Prepare to uninstall Clippity"
      subtitle="This wizard will remove Clippity from your device. You can choose what data to remove or keep."
      footer={
        <>
          <Button variant="secondary" onClick={back}>
            Back
          </Button>
          <Button onClick={() => goToStep("choose-data")}>Next</Button>
        </>
      }
    >
      <div className="pb-6">
        <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-4 py-1">
          <div className="py-2.5 text-[12px] font-semibold text-[var(--color-slate)]">
            Storage and data summary
          </div>
          <div className="divide-y divide-[var(--hairline)]">
            {DATA_CATEGORIES.map((cat) => {
              const Icon = ICON[cat.id] ?? AppWindow;
              return (
                <div key={cat.id} className="flex items-center gap-3 py-2.5">
                  <Icon
                    size={16}
                    strokeWidth={1.8}
                    className="shrink-0 text-[var(--color-hint)]"
                  />
                  <span className="flex-1 text-[13px] text-[var(--color-ink)]">
                    {cat.name}
                  </span>
                  <span className="text-[12.5px] tabular-nums text-[var(--color-slate)]">
                    {formatBytes(cat.sizeBytes)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-md)] border border-[color:color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[var(--color-accent-soft)] px-3.5 py-3">
          <TriangleAlert
            size={16}
            strokeWidth={1.9}
            className="mt-0.5 shrink-0 text-[var(--color-accent)]"
          />
          <p className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
            Your captures and projects can be kept on this device. You&apos;ll
            choose what to remove in the next step.
          </p>
        </div>
      </div>
    </StepShell>
  );
}
