import { useEffect, useState } from "react";

import type { StepId, WizardFlow } from "@clippity/installer-shared";
import { Providers } from "@app/Providers";
import { WizardWindow } from "@features/wizard/components/WizardWindow";
import { FlowSwitcher } from "@features/wizard/components/FlowSwitcher";
import { FLOW_STEPS, useWizardStore } from "@state/wizardStore";
import * as backend from "@services/installer";
import { hasTauri } from "@services/tauri";

/**
 * The entry flow is chosen by the hash route so the same bundle serves
 * all three launch modes:
 *   - `#/setup`       fresh install (the default when run from a download)
 *   - `#/maintenance` an existing install → the maintenance hub
 *   - `#/uninstall`   an existing install → straight into removal
 *
 * A real shell would decide this by detecting an existing install and
 * the `/uninstall` command-line flag; the hash keeps every path reachable
 * in preview.
 */
function flowFromHash(): WizardFlow {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "maintenance") return "maintenance";
  if (hash === "uninstall") return "uninstall";
  return "setup";
}

export function App() {
  return (
    <Providers>
      <AppShell />
    </Providers>
  );
}

function AppShell() {
  const setFlow = useWizardStore((s) => s.setFlow);
  const [ready, setReady] = useState(false);

  // Boot in one ordered pass. The resume check has to come first and win
  // outright: it and the hash router both set the flow and the step, so
  // running them concurrently would let the router send a resumed install
  // back to the Welcome screen.
  useEffect(() => {
    let cancelled = false;

    /** Route from the hash. Returns nothing; leaves the store on a step. */
    const applyHash = () => {
      const flow = flowFromHash();
      setFlow(flow);
      // Dev-only deep-link: `?step=<id>` jumps straight to a step so any
      // screen is reachable on a fresh load (which mounts without the
      // step-transition wait). Stripped from production builds.
      if (import.meta.env.DEV) {
        const target = new URLSearchParams(window.location.search).get(
          "step"
        ) as StepId | null;
        if (target && FLOW_STEPS[flow].includes(target)) {
          useWizardStore.getState().goToStep(target);
        }
      }
    };

    void (async () => {
      // A process launched with `--resume` was started by an unelevated
      // instance whose destination needed administrator rights. The user
      // has already answered every question and approved the UAC prompt,
      // so skip the wizard and execute the plan they assembled.
      const plan = await backend.takePendingPlan();
      if (cancelled) return;
      if (plan) {
        const store = useWizardStore.getState();
        store.setFlow("setup");
        store.setOptions(plan.options);
        store.goToStep("installing");
        void store.startOperation("install", "complete", plan);
        setReady(true);
        return;
      }

      // The removal analogue: launched elevated with `--resume-uninstall`
      // to finish a removal the unelevated instance could not. The user has
      // already confirmed their choices, so run them straight away.
      const removal = await backend.takePendingRemoval();
      if (cancelled) return;
      if (removal) {
        const store = useWizardStore.getState();
        store.setFlow("uninstall");
        useWizardStore.setState({
          removeIds: removal.removeIds,
          exportSettings: removal.exportSettings,
          acknowledged: removal.acknowledged,
        });
        store.goToStep("uninstalling");
        void store.startOperation("uninstall", "complete");
        setReady(true);
        return;
      }

      // Launched interactively from the Add/Remove Programs Uninstall /
      // Modify buttons: the backend maps the launch mode to a flow + step,
      // since a launched window has no URL hash to route from.
      const route = await backend.getLaunchRoute();
      if (cancelled) return;
      if (route) {
        const store = useWizardStore.getState();
        store.setFlow(route.flow);
        store.goToStep(route.step);
        setReady(true);
        return;
      }

      applyHash();
      // Only a hash-routed launch reacts to later hash changes; a resumed
      // or mode-routed launch has no route to go back to.
      window.addEventListener("hashchange", applyHash);
      setReady(true);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", applyHash);
    };
  }, [setFlow]);

  if (!ready) return null;

  return (
    <>
      <WizardWindow />
      {/* The flow switcher is a preview-only affordance for reaching all
          three launch modes in a browser; under the real Tauri shell the
          launch mode is fixed at startup, so it must never ship. */}
      {!hasTauri() && <FlowSwitcher />}
    </>
  );
}
