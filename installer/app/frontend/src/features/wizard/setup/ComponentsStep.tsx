import type { ComponentType } from "react";
import {
  AppWindow,
  Camera,
  Cloud,
  FileType2,
  Film,
  ScanText,
  Zap,
} from "lucide-react";

import type { Component } from "@clippity/installer-shared";
import { Button, Checkbox, IconTile } from "@shared/ui";
import { cn } from "@shared/lib/cn";
import { formatBytes } from "@shared/lib/format";
import { COMPONENTS } from "@config/catalog";
import { useWizardStore } from "@state/wizardStore";

import { StepShell } from "../components/StepShell";

const COMPONENT_ICON: Record<
  string,
  ComponentType<{ size?: number; strokeWidth?: number }>
> = {
  core: AppWindow,
  capture: Camera,
  assoc: FileType2,
  startup: Zap,
  gif: Film,
  ocr: ScanText,
  cloud: Cloud,
};

function ComponentRow({ component }: { component: Component }) {
  const selected = useWizardStore((s) =>
    s.selectedComponents.includes(component.id)
  );
  const toggle = useWizardStore((s) => s.toggleComponent);
  const Icon = COMPONENT_ICON[component.id] ?? AppWindow;
  const checked = component.required || selected;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 transition-colors",
        checked
          ? "border-[var(--hairline-strong)] bg-[var(--color-overlay-1)]"
          : "border-transparent hover:bg-[var(--color-overlay-1)]"
      )}
    >
      <IconTile icon={Icon} size={34} tint={checked ? "accent" : "neutral"} />
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium text-[var(--color-ink)]">
          {component.name}
        </div>
        <div className="truncate text-[12px] text-[var(--color-slate)]">
          {component.description}
        </div>
      </div>
      <span className="text-[12px] tabular-nums text-[var(--color-hint)]">
        {formatBytes(component.sizeBytes)}
      </span>
      <Checkbox
        checked={checked}
        disabled={component.required}
        onChange={() => toggle(component.id)}
        label={component.name}
      />
    </div>
  );
}

/** Setup step 3 — choose which features to install. */
export function ComponentsStep() {
  const back = useWizardStore((s) => s.back);
  const goToStep = useWizardStore((s) => s.goToStep);

  const recommended = COMPONENTS.filter((c) => c.required || c.recommendedDefault);
  const optional = COMPONENTS.filter((c) => !c.required && !c.recommendedDefault);

  return (
    <StepShell
      title="Choose components"
      subtitle="Select which features you want to install."
      headerAside={
        <span className="rounded-full bg-[var(--color-accent-soft)] px-3 py-1 text-[12px] font-medium text-[var(--color-accent)]">
          Recommended
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={back}>
            Back
          </Button>
          <Button onClick={() => goToStep("review")}>Next</Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5 pb-6">
        {recommended.map((c) => (
          <ComponentRow key={c.id} component={c} />
        ))}

        <div className="mt-3 mb-1 px-1 text-[11.5px] font-semibold uppercase tracking-wide text-[var(--color-hint)]">
          Optional
        </div>
        {optional.map((c) => (
          <ComponentRow key={c.id} component={c} />
        ))}
      </div>
    </StepShell>
  );
}
