import type { ComponentType } from "react";
import {
  ClipboardCheck,
  CloudDownload,
  Database,
  Loader2,
  PartyPopper,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import type { StepId } from "@clippity/installer-shared";
import { StepRail, TitleBar, WindowFrame } from "@shared/ui";
import { railFor, useWizardStore } from "@state/wizardStore";

import { WelcomeStep } from "../setup/WelcomeStep";
import { OptionsStep } from "../setup/OptionsStep";
import { ComponentsStep } from "../setup/ComponentsStep";
import { ReviewStep } from "../setup/ReviewStep";
import { MaintenanceHub } from "../maintenance/MaintenanceHub";
import { CheckUpdatesStep } from "../maintenance/CheckUpdatesStep";
import { UpdateAvailableStep } from "../maintenance/UpdateAvailableStep";
import { ModifyStep } from "../maintenance/ModifyStep";
import { PrepareUninstallStep } from "../uninstall/PrepareUninstallStep";
import { ChooseDataStep } from "../uninstall/ChooseDataStep";
import { ReviewRemovalStep } from "../uninstall/ReviewRemovalStep";
import { ProgressStep } from "./ProgressStep";
import { CompleteStep } from "./CompleteStep";

/** Rail icons for the icon-led flows; setup uses plain numbers. */
const RAIL_ICONS: Partial<
  Record<StepId, ComponentType<{ size?: number; strokeWidth?: number }>>
> = {
  maintenance: Wrench,
  "check-updates": CloudDownload,
  "update-available": Sparkles,
  modify: SlidersHorizontal,
  applying: Loader2,
  "prepare-uninstall": Trash2,
  "choose-data": Database,
  "review-removal": ClipboardCheck,
  uninstalling: Loader2,
  complete: PartyPopper,
};

/** Map the current step id to its screen. */
function StepView({ step }: { step: StepId }) {
  switch (step) {
    case "welcome":
      return <WelcomeStep />;
    case "options":
      return <OptionsStep />;
    case "components":
      return <ComponentsStep />;
    case "review":
      return <ReviewStep />;
    case "maintenance":
      return <MaintenanceHub />;
    case "check-updates":
      return <CheckUpdatesStep />;
    case "update-available":
      return <UpdateAvailableStep />;
    case "modify":
      return <ModifyStep />;
    case "prepare-uninstall":
      return <PrepareUninstallStep />;
    case "choose-data":
      return <ChooseDataStep />;
    case "review-removal":
      return <ReviewRemovalStep />;
    case "installing":
    case "applying":
    case "uninstalling":
      return <ProgressStep />;
    case "complete":
      return <CompleteStep />;
    default:
      return null;
  }
}

/**
 * The wizard shell: a custom title bar over a two-pane body — the step
 * rail on the left, the active step on the right. Steps crossfade/slide
 * as the user advances.
 */
export function WizardWindow() {
  const flow = useWizardStore((s) => s.flow);
  const step = useWizardStore((s) => s.step);
  const rail = railFor(flow);

  return (
    <WindowFrame>
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="flex min-h-0 flex-1 content-canvas overflow-hidden rounded-t-[var(--radius-lg)] border-t border-l border-r border-[var(--hairline)]">
          <StepRail steps={rail} current={step} icons={RAIL_ICONS} />
          <main className="relative min-w-0 flex-1">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={{ opacity: 0, x: 18 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -18 }}
                transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
                className="absolute inset-0"
              >
                <StepView step={step} />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </WindowFrame>
  );
}
