import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock,
  CloudDownload,
  FolderOpen,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "lucide-react";

import type { Detection, InstallState } from "@clippity/installer-shared";

import { Button, IconTile } from "@shared/ui";
import { cn } from "@shared/lib/cn";
import type { IconComponent } from "@shared/lib/icon";
import { openPath } from "@services/tauri";
import { detectInstallation, getMaintenancePaths } from "@services/installer";
import type { MaintenancePaths } from "@services/installer";
import { INSTALL_LOCATION, INSTALLED_VERSION, LAST_UPDATED } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

/** Health badge label + tone for a detected install state. */
const STATE_BADGE: Record<
  InstallState,
  { label: string; tone: "success" | "gold" | "accent" }
> = {
  "not-installed": { label: "Not installed", tone: "accent" },
  healthy: { label: "Installed", tone: "success" },
  "same-version": { label: "Installed", tone: "success" },
  "older-version": { label: "Update available", tone: "accent" },
  "newer-version": { label: "Newer version", tone: "gold" },
  damaged: { label: "Repair recommended", tone: "gold" },
  partial: { label: "Recovery needed", tone: "gold" },
  "legacy-unmanaged": { label: "Legacy install", tone: "gold" },
};

interface HubAction {
  key: "update" | "modify" | "repair" | "uninstall";
  icon: IconComponent;
  title: string;
  hint: string;
  tint: "accent" | "violet" | "gold" | "neutral";
  danger?: boolean;
}

const ACTIONS: HubAction[] = [
  {
    key: "update",
    icon: CloudDownload,
    title: "Update",
    hint: "Check for updates and install",
    tint: "accent",
  },
  {
    key: "modify",
    icon: SlidersHorizontal,
    title: "Modify",
    hint: "Change installed components and settings",
    tint: "violet",
  },
  {
    key: "repair",
    icon: Wrench,
    title: "Repair",
    hint: "Fix issues with your installation",
    tint: "gold",
  },
  {
    key: "uninstall",
    icon: Trash2,
    title: "Uninstall",
    hint: "Remove Clippity from this device",
    tint: "neutral",
    danger: true,
  },
];

/**
 * The maintenance hub — the shared entry point for both the maintenance
 * and uninstall flows. Presents the install status and the four actions
 * that branch into the rest of the wizard.
 */
export function MaintenanceHub() {
  // Real detection when running under the Tauri shell; the static catalog
  // snapshot in browser preview (where `detectInstallation` resolves
  // undefined). Never blocks first paint — the fallback renders immediately.
  const [detection, setDetection] = useState<Detection | null>(null);
  const [paths, setPaths] = useState<MaintenancePaths | null>(null);
  // Repair used to run the moment its card was clicked — with no
  // confirmation and, worse, under the "modify" progress labels. It now asks
  // first and runs with the correct repair progress.
  const [confirmingRepair, setConfirmingRepair] = useState(false);

  useEffect(() => {
    let live = true;
    detectInstallation()
      .then((d) => {
        if (live && d) setDetection(d);
      })
      .catch(() => {});
    getMaintenancePaths()
      .then((p) => {
        if (live) setPaths(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const runAction = (key: HubAction["key"]) => {
    const store = useWizardStore.getState();
    switch (key) {
      case "update":
        store.goToStep("check-updates");
        break;
      case "modify":
        store.goToStep("modify");
        break;
      case "repair":
        setConfirmingRepair(true);
        break;
      case "uninstall":
        store.setFlow("uninstall");
        store.goToStep("prepare-uninstall");
        break;
    }
  };

  const startRepair = () => {
    const store = useWizardStore.getState();
    store.goToStep("applying");
    void store.startOperation("repair", "complete");
  };

  const version = detection?.installedVersion ?? INSTALLED_VERSION;
  const location = detection?.installDirectory ?? paths?.appDir ?? INSTALL_LOCATION;
  const lastUpdated = LAST_UPDATED;
  const badge = detection ? STATE_BADGE[detection.state] : STATE_BADGE.healthy;
  const toneVar =
    badge.tone === "success"
      ? "--color-success"
      : badge.tone === "gold"
        ? "--color-gold"
        : "--color-accent";

  return (
    <StepShell
      title="Clippity is installed"
      subtitle={`Version ${version} • Stable`}
      headerAside={
        <span
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium"
          style={{
            backgroundColor: `color-mix(in srgb, var(${toneVar}) 16%, transparent)`,
            color: `var(${toneVar})`,
          }}
        >
          <CheckCircle2 size={14} strokeWidth={2} />
          {badge.label}
        </span>
      }
    >
      <div className="pb-6">
        {confirmingRepair ? (
          <RepairConfirm
            onCancel={() => setConfirmingRepair(false)}
            onConfirm={startRepair}
          />
        ) : (
          <>
            <p className="mb-4 text-[13px] text-[var(--color-slate)]">
              Use the options below to keep Clippity up to date and customize
              your installation.
            </p>

            <div className="grid grid-cols-2 gap-2.5">
              {ACTIONS.map((action) => (
                <HubCard
                  key={action.key}
                  action={action}
                  onSelect={() => runAction(action.key)}
                />
              ))}
            </div>

            <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-4 py-1 divide-y divide-[var(--hairline)]">
              <InfoRow
                icon={FolderOpen}
                label="Install location"
                value={location}
                action="Open folder"
                onAction={() => void openPath(paths?.appDir ?? location)}
              />
              <InfoRow
                icon={Clock}
                label="Last updated"
                value={lastUpdated}
                action="View log"
                onAction={() => void openPath(paths?.logFile ?? "")}
              />
            </div>
          </>
        )}
      </div>
    </StepShell>
  );
}

/** The Repair confirmation shown before the (non-destructive) repair runs. */
function RepairConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-5">
      <div className="flex items-start gap-3">
        <IconTile icon={Wrench} tint="gold" size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-[var(--color-ink)]">
            Repair Clippity?
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-slate)]">
            This restores any missing or damaged application files and
            re-registers integrations. Your settings, captures, and projects
            are preserved, and the installed version stays the same.
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm}>
          <Wrench size={15} strokeWidth={2} />
          Repair
        </Button>
      </div>
    </div>
  );
}

function HubCard({
  action,
  onSelect,
}: {
  action: HubAction;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex flex-col items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-4 text-left transition-all",
        "hover:-translate-y-0.5 hover:border-[var(--color-accent)] hover:bg-[var(--color-overlay-2)] hover:shadow-[var(--shadow-medium)]"
      )}
    >
      <IconTile
        icon={action.icon}
        tint={action.danger ? "neutral" : action.tint}
        size={40}
      />
      <div>
        <div
          className={cn(
            "text-[14px] font-semibold",
            action.danger
              ? "text-[var(--color-ink)] group-hover:text-[var(--color-accent)]"
              : "text-[var(--color-ink)]"
          )}
        >
          {action.title}
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-[var(--color-slate)]">
          {action.hint}
        </div>
      </div>
    </button>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
  action,
  onAction,
}: {
  icon: IconComponent;
  label: string;
  value: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Icon size={15} strokeWidth={1.8} className="shrink-0 text-[var(--color-hint)]" />
      <span className="shrink-0 text-[12.5px] text-[var(--color-slate)]">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--color-ink)]">
        {value}
      </span>
      <button
        type="button"
        onClick={onAction}
        className="shrink-0 rounded-[var(--radius-sm)] px-2 py-1 text-[12px] font-medium text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent-soft)]"
      >
        {action}
      </button>
    </div>
  );
}
