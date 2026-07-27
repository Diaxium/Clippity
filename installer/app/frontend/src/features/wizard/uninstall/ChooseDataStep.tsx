import { Download, Info } from "lucide-react";

import type { DataCategory } from "@clippity/installer-shared";
import { Button, Checkbox } from "@shared/ui";
import { cn } from "@shared/lib/cn";
import { formatBytes } from "@shared/lib/format";
import { DATA_CATEGORIES } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

/**
 * A data row. Checking the box marks the category for removal; an explicit
 * status pill states the outcome ("Kept" / "Will be removed") so a row never
 * relies on a section header to be understood — the previous "Keep" section
 * full of "Remove …" checkboxes read as a contradiction.
 */
function DataRow({ cat }: { cat: DataCategory }) {
  const checked = useWizardStore((s) => s.removeIds.includes(cat.id));
  const toggle = useWizardStore((s) => s.toggleRemove);
  return (
    <label className="flex cursor-pointer items-center gap-3 py-2.5">
      <Checkbox
        checked={checked}
        onChange={() => toggle(cat.id)}
        label={`Remove ${cat.name}`}
      />
      <span className="flex-1 text-[13px] text-[var(--color-ink)]">
        {cat.name}
      </span>
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-[11px] font-medium",
          checked
            ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
            : "bg-[var(--color-overlay-2)] text-[var(--color-slate)]"
        )}
      >
        {checked ? "Will be removed" : "Kept"}
      </span>
      <span className="w-16 text-right text-[12.5px] tabular-nums text-[var(--color-slate)]">
        {formatBytes(cat.sizeBytes)}
      </span>
    </label>
  );
}

/** Uninstall step 3 — pick which data categories to delete vs keep. */
export function ChooseDataStep() {
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);
  const exportSettings = useWizardStore((s) => s.exportSettings);
  const setExportSettings = useWizardStore((s) => s.setExportSettings);

  const removable = DATA_CATEGORIES.filter((c) => !c.destructive);
  const keepable = DATA_CATEGORIES.filter((c) => c.destructive);

  return (
    <StepShell
      title="Choose what data to remove"
      subtitle="Select the items you want to remove from this device."
      footer={
        <>
          <Button variant="secondary" onClick={back}>
            Back
          </Button>
          <Button onClick={() => goToStep("review-removal")}>Next</Button>
        </>
      }
    >
      <div className="pb-6">
        <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-4">
          <div className="py-2.5 text-[12px] font-semibold text-[var(--color-slate)]">
            Application data
            <span className="ml-1.5 font-normal text-[var(--color-hint)]">
              — removed by default
            </span>
          </div>
          <div className="divide-y divide-[var(--hairline)] border-t border-[var(--hairline)]">
            {removable.map((c) => (
              <DataRow key={c.id} cat={c} />
            ))}
          </div>
        </div>

        <div className="mt-3 rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-4">
          <div className="py-2.5 text-[12px] font-semibold text-[var(--color-slate)]">
            Your personal data
            <span className="ml-1.5 font-normal text-[var(--color-hint)]">
              — kept unless you check it
            </span>
          </div>
          <div className="divide-y divide-[var(--hairline)] border-t border-[var(--hairline)]">
            {keepable.map((c) => (
              <DataRow key={c.id} cat={c} />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setExportSettings(!exportSettings)}
            className="flex items-center gap-1.5 py-3 text-[12.5px] font-medium text-[var(--color-accent)] hover:underline"
          >
            <Download size={13} strokeWidth={2} />
            {exportSettings
              ? "Settings will be exported before uninstall"
              : "Export settings before uninstall"}
          </button>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--color-overlay-1)] px-3.5 py-3">
          <Info
            size={15}
            strokeWidth={1.9}
            className="mt-0.5 shrink-0 text-[var(--color-slate)]"
          />
          <p className="text-[12.5px] leading-relaxed text-[var(--color-slate)]">
            Destructive content removal is optional and disabled by default.
            Your captures and projects will be kept unless you choose to remove
            them.
          </p>
        </div>
      </div>
    </StepShell>
  );
}
