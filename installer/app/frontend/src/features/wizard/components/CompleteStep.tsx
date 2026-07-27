import { useEffect, useState } from "react";
import {
  BookOpen,
  FolderOpen,
  Rocket,
  RotateCcw,
  ScrollText,
  Settings,
  Sparkles,
  Image as ImageIcon,
} from "lucide-react";
import { motion } from "motion/react";

import { Button, SuccessBurst } from "@shared/ui";
import { cn } from "@shared/lib/cn";
import { formatBytes } from "@shared/lib/format";
import { closeWindow, openPath } from "@services/tauri";
import * as backend from "@services/installer";
import { DATA_CATEGORIES, LINKS } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

/** Setup / maintenance / uninstall all land here with tailored copy. */
export function CompleteStep() {
  const flow = useWizardStore((s) => s.flow);
  const setFlow = useWizardStore((s) => s.setFlow);
  const removeIds = useWizardStore((s) => s.removeIds);
  const rebootRequired = useWizardStore((s) => s.progress?.rebootRequired ?? false);

  const isUninstall = flow === "uninstall";
  const isMaintenance = flow === "maintenance";

  // Real targets for the action buttons (null in browser preview, where the
  // openers no-op anyway).
  const [paths, setPaths] = useState<backend.MaintenancePaths | null>(null);
  useEffect(() => {
    let live = true;
    backend
      .getMaintenancePaths()
      .then((p) => {
        if (live) setPaths(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const launch = () => void backend.launchApp();
  const openData = () => void openPath(paths?.dataDir ?? "");
  const openLog = () => void openPath(paths?.logFile ?? "");

  const title = isUninstall
    ? "Uninstall complete"
    : isMaintenance
      ? "Changes completed successfully!"
      : "Installation complete!";
  const subtitle = isUninstall
    ? "Clippity has been removed from this device."
    : isMaintenance
      ? "Clippity has been updated and your installation settings were applied."
      : "Clippity has been installed successfully.";

  const logLabel = isUninstall
    ? "View uninstall log"
    : isMaintenance
      ? "View maintenance log"
      : "View installation log";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <SuccessBurst size={86} />

        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--color-ink)]"
        >
          {title}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22 }}
          className="mt-2 max-w-[380px] text-[13px] leading-relaxed text-[var(--color-slate)]"
        >
          {subtitle}
        </motion.p>

        {isUninstall ? (
          <KeptDataSummary removeIds={removeIds} />
        ) : null}

        {rebootRequired ? <RebootNotice /> : null}

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mt-7 flex w-[300px] flex-col gap-2"
        >
          {isUninstall ? (
            <>
              {/* After a removal there is no primary action to push — the
                  footer's Done is the exit — so both options stay secondary. */}
              <Button size="lg" variant="secondary" onClick={openData}>
                <FolderOpen size={16} strokeWidth={2} />
                Open retained data folder
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => setFlow("setup")}
              >
                Reinstall Clippity
              </Button>
            </>
          ) : (
            <>
              <Button size="lg" onClick={launch}>
                <Rocket size={16} strokeWidth={2} />
                Launch Clippity
              </Button>
              {isMaintenance ? (
                <>
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={() => void openPath(LINKS.releaseNotes)}
                  >
                    <ScrollText size={15} strokeWidth={1.9} />
                    View release notes
                  </Button>
                  <Button size="lg" variant="secondary" onClick={launch}>
                    <Settings size={15} strokeWidth={1.9} />
                    Open settings
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={() => void openPath(LINKS.docs)}
                  >
                    <BookOpen size={15} strokeWidth={1.9} />
                    Open documentation
                  </Button>
                  <Button
                    size="lg"
                    variant="secondary"
                    onClick={() => void openPath(LINKS.whatsNew)}
                  >
                    <Sparkles size={15} strokeWidth={1.9} />
                    What&apos;s new
                  </Button>
                </>
              )}
            </>
          )}
        </motion.div>
      </div>

      <div className="flex items-center px-7 py-4">
        <button
          type="button"
          onClick={openLog}
          className="flex items-center gap-1.5 text-[12px] text-[var(--color-hint)] transition-colors hover:text-[var(--color-slate)]"
        >
          <ScrollText size={13} strokeWidth={1.9} />
          {logLabel}
        </button>
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => void closeWindow()}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * Shown when the operation finished but a locked file was scheduled for
 * removal at the next reboot — so the Complete screen tells the truth
 * instead of claiming an unqualified success.
 */
function RebootNotice() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.26 }}
      className="mt-5 flex w-[380px] items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] px-3.5 py-3 text-left"
    >
      <RotateCcw
        size={16}
        strokeWidth={1.9}
        className="mt-0.5 shrink-0 text-[var(--color-accent)]"
      />
      <p className="text-[12.5px] leading-relaxed text-[var(--color-slate)]">
        A restart is required to finish. Some files were in use and will be
        removed the next time you restart this device.
      </p>
    </motion.div>
  );
}

/** The "Kept on this device" strip on the uninstall complete screen. */
function KeptDataSummary({ removeIds }: { removeIds: string[] }) {
  const kept = DATA_CATEGORIES.filter(
    (c) => c.destructive && !removeIds.includes(c.id)
  );
  const captures = kept.find((c) => c.id === "content");
  const settings = kept.find((c) => c.id === "settings");

  const tiles = [
    captures && {
      icon: ImageIcon,
      label: "Captures & projects",
      value: formatBytes(captures.sizeBytes),
    },
    settings && {
      icon: Settings,
      label: "Settings",
      value: formatBytes(settings.sizeBytes),
    },
  ].filter(Boolean) as Array<{
    icon: typeof ImageIcon;
    label: string;
    value: string;
  }>;

  if (tiles.length === 0) return null;

  return (
    <div className="mt-6 w-[380px] rounded-[var(--radius-lg)] border border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] p-4">
      <div className="mb-3 text-[12px] font-semibold text-[var(--color-slate)]">
        Kept on this device
      </div>
      <div
        className={cn(
          "grid gap-2",
          tiles.length === 1 ? "grid-cols-1" : "grid-cols-2"
        )}
      >
        {tiles.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex flex-col items-center gap-1">
            <Icon size={18} strokeWidth={1.8} className="text-[var(--color-accent)]" />
            <span className="text-[13px] font-semibold text-[var(--color-ink)]">
              {value}
            </span>
            <span className="text-[11px] text-[var(--color-hint)]">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
