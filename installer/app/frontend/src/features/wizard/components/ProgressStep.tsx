import { Info } from "lucide-react";

import type { ProgressKind } from "@clippity/installer-shared";
import { ProgressBar, ProgressChecklist } from "@shared/ui";
import { DATA_CATEGORIES } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "./StepShell";

const COPY: Record<
  ProgressKind,
  { title: string; subtitle: string; note?: string }
> = {
  install: {
    title: "Installing Clippity",
    subtitle: "Please wait while we install Clippity on your computer.",
  },
  modify: {
    title: "Applying changes",
    subtitle:
      "Please wait while Clippity updates and configures your installation.",
    note: "Your settings, captures, and data will be preserved. Please don't close this window.",
  },
  repair: {
    title: "Repairing Clippity",
    subtitle:
      "Please wait while Clippity restores missing or damaged files.",
    note: "Your settings, captures, and data will be preserved. Please don't close this window.",
  },
  update: {
    title: "Applying changes",
    subtitle:
      "Please wait while Clippity updates and configures your installation.",
    note: "Your settings, captures, and data will be preserved. Please don't close this window.",
  },
  uninstall: {
    title: "Removing Clippity",
    subtitle: "Please wait while we remove Clippity from your device.",
    note: "Your captures and projects will stay on this device. Only the items you selected for removal are being deleted.",
  },
};

/**
 * The shared progress screen for every long-running operation. It reads
 * the live `progress` snapshot from the store (driven by the simulated
 * runner, or by `installer://progress` events under Tauri) and renders a
 * percentage bar plus the task checklist.
 */
export function ProgressStep() {
  const progress = useWizardStore((s) => s.progress);
  const removeIds = useWizardStore((s) => s.removeIds);

  const kind = progress?.kind ?? "install";
  const copy = COPY[kind];
  const percent = progress?.percent ?? 0;
  const tasks = progress?.tasks ?? [];

  // The uninstall note must reflect the actual selection: the default keeps
  // personal content, but a user who opted to delete it should not be told
  // it will be kept.
  const removingPersonalData =
    kind === "uninstall" &&
    DATA_CATEGORIES.some((c) => c.destructive && removeIds.includes(c.id));
  const note =
    kind === "uninstall" && removingPersonalData
      ? "The items you selected — including personal data such as captures, projects, or settings — are being permanently removed."
      : copy.note;

  // No Cancel control: the backend has no way to abort a removal or install
  // mid-write, so offering "Cancel" (which only navigated away while the
  // operation kept running) was misleading. The window can still be closed.
  return (
    <StepShell title={copy.title} subtitle={copy.subtitle}>
      <div className="pb-6">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12.5px] text-[var(--color-slate)]">
            {tasks.find((t) => t.state === "in-progress")?.label ?? "Finishing up"}
            …
          </span>
          <span className="text-[13px] font-semibold tabular-nums text-[var(--color-ink)]">
            {percent}%
          </span>
        </div>
        <ProgressBar percent={percent} />

        <div className="mt-5">
          <ProgressChecklist tasks={tasks} />
        </div>

        {note && (
          <div className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--color-overlay-1)] px-3.5 py-3">
            <Info
              size={15}
              strokeWidth={1.9}
              className="mt-0.5 shrink-0 text-[var(--color-slate)]"
            />
            <p className="text-[12.5px] leading-relaxed text-[var(--color-slate)]">
              {note}
            </p>
          </div>
        )}
      </div>
    </StepShell>
  );
}
