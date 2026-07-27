import { useState } from "react";
import { ShieldAlert, Trash2 } from "lucide-react";

import { Button, ToggleSwitch } from "@shared/ui";
import { cn } from "@shared/lib/cn";
import { formatBytes } from "@shared/lib/format";
import { DATA_CATEGORIES } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";
import * as backend from "@services/installer";

import { StepShell } from "../components/StepShell";

/** Uninstall step 4 — the removed/kept breakdown + the required consent. */
export function ReviewRemovalStep() {
  const removeIds = useWizardStore((s) => s.removeIds);
  const exportSettings = useWizardStore((s) => s.exportSettings);
  const acknowledged = useWizardStore((s) => s.acknowledged);
  const setAcknowledged = useWizardStore((s) => s.setAcknowledged);
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);
  const startOperation = useWizardStore((s) => s.startOperation);

  const [busy, setBusy] = useState(false);
  const [elevationError, setElevationError] = useState<string | null>(null);

  const removed = DATA_CATEGORIES.filter((c) => removeIds.includes(c.id));
  const kept = DATA_CATEGORIES.filter((c) => !removeIds.includes(c.id));
  const removedBytes = removed.reduce((s, c) => s + c.sizeBytes, 0);
  const keptBytes = kept.reduce((s, c) => s + c.sizeBytes, 0);

  /**
   * Start the removal, taking the elevated path only when the installed
   * location actually needs it.
   *
   * A per-user install in a writable folder removes right here. An install
   * under a protected location (or an all-users install) hands the removal
   * to an elevated copy, which resumes at the Uninstalling step — otherwise
   * the unelevated process reports success while every file survives.
   * Declining the UAC prompt leaves the user on this step, choices intact.
   */
  const uninstall = async () => {
    setBusy(true);
    setElevationError(null);
    try {
      if (await backend.uninstallRequiresElevation()) {
        // Hands off and closes this window; nothing after it runs.
        await backend.elevateAndUninstall({
          removeIds,
          exportSettings,
          acknowledged,
        });
        return;
      }

      goToStep("uninstalling");
      void startOperation("uninstall", "complete");
    } catch (err) {
      setElevationError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <StepShell
      title="Review your removal choices"
      subtitle="Please review what will be removed and what will be kept."
      footerLeft={
        <label className="flex cursor-pointer items-center gap-2.5">
          <ToggleSwitch
            checked={acknowledged}
            onChange={setAcknowledged}
            label="I understand selected items will be permanently removed"
          />
          <span className="text-[12px] text-[var(--color-slate)]">
            I understand that selected items will be permanently removed.
          </span>
        </label>
      }
      footer={
        <>
          <Button variant="secondary" onClick={back} disabled={busy}>
            Back
          </Button>
          <Button
            variant="danger"
            disabled={!acknowledged || busy}
            onClick={uninstall}
          >
            <Trash2 size={15} strokeWidth={2} />
            {busy ? "Starting…" : "Uninstall"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 pb-6">
        <RemovalColumn
          title="Will be removed"
          tone="danger"
          items={removed}
          total={removedBytes}
        />
        <RemovalColumn
          title="Will be kept"
          tone="keep"
          items={kept}
          total={keptBytes}
        />
      </div>

      {elevationError && (
        <div
          role="alert"
          className="mb-6 flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-4"
        >
          <ShieldAlert
            size={16}
            strokeWidth={2}
            className="mt-0.5 shrink-0 text-[var(--color-accent)]"
          />
          <div className="text-[13px] text-[var(--color-slate)]">
            {elevationError}
            <div className="mt-1">
              Removing this installation needs administrator rights. Approve
              the prompt to continue, or close and relaunch as administrator.
            </div>
          </div>
        </div>
      )}
    </StepShell>
  );
}

function RemovalColumn({
  title,
  tone,
  items,
  total,
}: {
  title: string;
  tone: "danger" | "keep";
  items: typeof DATA_CATEGORIES;
  total: number;
}) {
  const danger = tone === "danger";
  return (
    <div className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-3.5">
      <div
        className={cn(
          "mb-2 text-[12.5px] font-semibold",
          danger ? "text-[var(--color-accent)]" : "text-[var(--color-success)]"
        )}
      >
        {title}
      </div>
      <div className="min-h-0 flex-1 divide-y divide-[var(--hairline)]">
        {items.length === 0 ? (
          <div className="py-2.5 text-[12.5px] text-[var(--color-hint)]">
            Nothing in this list.
          </div>
        ) : (
          items.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-2">
              <span className="flex-1 text-[12.5px] text-[var(--color-ink)]">
                {c.name}
              </span>
              <span className="text-[12px] tabular-nums text-[var(--color-slate)]">
                {formatBytes(c.sizeBytes)}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="mt-2 flex items-center justify-between border-t border-[var(--hairline-strong)] pt-2.5">
        <span className="text-[12px] font-medium text-[var(--color-slate)]">
          {danger ? "Total to be removed" : "Total to be kept"}
        </span>
        <span
          className={cn(
            "text-[13px] font-semibold",
            danger ? "text-[var(--color-accent)]" : "text-[var(--color-ink)]"
          )}
        >
          {formatBytes(total)}
        </span>
      </div>
    </div>
  );
}
