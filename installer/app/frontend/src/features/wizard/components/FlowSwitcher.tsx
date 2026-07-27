import { Download, RefreshCw, Trash2 } from "lucide-react";

import type { WizardFlow } from "@clippity/installer-shared";
import { cn } from "@shared/lib/cn";
import { useWizardStore } from "@state/wizardStore";

/**
 * A small preview affordance for jumping between the three launch modes.
 *
 * In a shipping build the entry flow is fixed at launch (fresh download →
 * setup; existing install → maintenance; `/uninstall` flag → uninstall),
 * so this pill would not ship — it exists so every flow is reachable in a
 * browser preview without re-launching.
 */
const ENTRIES: Array<{
  flow: WizardFlow;
  label: string;
  icon: typeof Download;
}> = [
  { flow: "setup", label: "Install", icon: Download },
  { flow: "maintenance", label: "Maintain", icon: RefreshCw },
  { flow: "uninstall", label: "Uninstall", icon: Trash2 },
];

export function FlowSwitcher() {
  const flow = useWizardStore((s) => s.flow);
  const setFlow = useWizardStore((s) => s.setFlow);

  return (
    <div className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--hairline-strong)] bg-[var(--float-bg)] p-1 shadow-[var(--shadow-elevated)] backdrop-blur-md">
      <span className="px-2 text-[10.5px] font-medium uppercase tracking-wide text-[var(--color-hint)]">
        Preview
      </span>
      {ENTRIES.map(({ flow: f, label, icon: Icon }) => (
        <button
          key={f}
          type="button"
          onClick={() => setFlow(f)}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors",
            flow === f
              ? "bg-[var(--color-accent)] text-[var(--color-accent-ink)]"
              : "text-[var(--color-slate)] hover:bg-[var(--color-overlay-2)] hover:text-[var(--color-ink)]"
          )}
        >
          <Icon size={13} strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  );
}
