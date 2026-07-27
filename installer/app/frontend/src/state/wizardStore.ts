/**
 * The wizard engine.
 *
 * Holds which flow is running, the current step, every user selection
 * across all three flows, and the live progress of a running operation.
 * Navigation uses a history stack so `back()` is correct even across the
 * maintenance hub's branches (Update / Modify / Repair / Uninstall all
 * leave from the same step).
 *
 * The progress runner has two backends. Under the Tauri shell it invokes
 * the matching Rust command and renders the `installer://progress`
 * snapshots that come back, so the checklist reflects real work. In a
 * plain browser (where there is no backend) it walks the same domain
 * checklist on a timer, keeping every screen previewable. Either way the
 * Installing / Applying / Uninstalling steps render from `progress`.
 */

import { create } from "zustand";

import type {
  InstallOptions,
  InstallPlan,
  ProgressKind,
  ProgressTask,
  ReleaseChannel,
  WizardFlow,
  StepId,
} from "@clippity/installer-shared";

import { COMPONENTS, DATA_CATEGORIES, PRODUCT } from "@config/catalog";
import * as backend from "@services/installer";
import { hasTauri } from "@services/tauri";

/** Ordered step rail per flow — mirrors Rust `wizard::steps_for`. */
export const FLOW_STEPS: Record<WizardFlow, StepId[]> = {
  setup: ["welcome", "options", "components", "review", "installing", "complete"],
  maintenance: [
    "maintenance",
    "check-updates",
    "update-available",
    "modify",
    "applying",
    "complete",
  ],
  uninstall: [
    "maintenance",
    "prepare-uninstall",
    "choose-data",
    "review-removal",
    "uninstalling",
    "complete",
  ],
};

/** The checklist rows for each long-running operation. */
const CHECKLISTS: Record<ProgressKind, Array<{ id: string; label: string }>> = {
  install: [
    { id: "download", label: "Downloading" },
    { id: "verify", label: "Verifying" },
    { id: "files", label: "Installing files" },
    { id: "integrations", label: "Registering integrations" },
    { id: "finalize", label: "Finalizing installation" },
  ],
  modify: [
    { id: "download", label: "Downloading update" },
    { id: "verify", label: "Verifying package" },
    { id: "files", label: "Updating files" },
    { id: "integrations", label: "Registering integrations" },
    { id: "backup", label: "Backing up previous version" },
    { id: "finalize", label: "Finalizing" },
  ],
  update: [
    { id: "download", label: "Downloading update" },
    { id: "verify", label: "Verifying package" },
    { id: "files", label: "Updating files" },
    { id: "integrations", label: "Registering integrations" },
    { id: "backup", label: "Backing up previous version" },
    { id: "finalize", label: "Finalizing" },
  ],
  repair: [
    { id: "scan", label: "Checking installation" },
    { id: "verify", label: "Verifying files" },
    { id: "restore", label: "Restoring files" },
    { id: "integrations", label: "Re-registering integrations" },
    { id: "finalize", label: "Finalizing repair" },
  ],
  uninstall: [
    { id: "processes", label: "Closing running processes" },
    { id: "appfiles", label: "Removing application files" },
    { id: "shortcuts", label: "Removing shortcuts" },
    { id: "cache", label: "Cleaning cache" },
    { id: "registry", label: "Updating system registrations" },
    { id: "finalize", label: "Finalizing uninstall" },
  ],
};

export interface ProgressState {
  kind: ProgressKind;
  percent: number;
  tasks: ProgressTask[];
  done: boolean;
  /** Set on the terminal event when a reboot is needed to finish. */
  rebootRequired?: boolean;
}

interface WizardState {
  flow: WizardFlow;
  step: StepId;
  history: StepId[];

  // ---- setup / modify selections ----
  options: InstallOptions;
  selectedComponents: string[];
  /** True once `hydrateFromInstalled` has run, so re-entering Modify does
   *  not discard the edits the user came back with. */
  hydratedFromInstalled: boolean;

  // ---- update / maintenance ----
  channel: ReleaseChannel;
  checkedForUpdates: boolean;

  // ---- uninstall selections ----
  removeIds: string[];
  exportSettings: boolean;
  acknowledged: boolean;

  // ---- running operation ----
  progress: ProgressState | null;
  /** Message from a failed operation, or null while things are fine. */
  operationError: string | null;

  // ---- navigation ----
  setFlow: (flow: WizardFlow) => void;
  goToStep: (step: StepId) => void;
  back: () => void;

  // ---- setup / modify mutations ----
  setOptions: (patch: Partial<InstallOptions>) => void;
  toggleComponent: (id: string) => void;
  /**
   * Replace the options + component selection with what is actually
   * installed. Awaited before the Modify step renders; a no-op when nothing
   * is installed or there is no backend to ask.
   */
  hydrateFromInstalled: () => Promise<void>;

  // ---- update / maintenance mutations ----
  setChannel: (channel: ReleaseChannel) => void;
  markCheckedForUpdates: () => void;

  // ---- uninstall mutations ----
  toggleRemove: (id: string) => void;
  setExportSettings: (value: boolean) => void;
  setAcknowledged: (value: boolean) => void;

  // ---- operations ----
  /**
   * Run `kind` and advance to `landOn` when it completes. `plan` overrides
   * the store's own selections — used when resuming an elevated install.
   */
  startOperation: (
    kind: ProgressKind,
    landOn: StepId,
    plan?: InstallPlan
  ) => Promise<void>;
  /** Record a failed operation and mark the running row as failed. */
  failOperation: (err: unknown) => void;
  reset: () => void;
}

/** Recommended-default component ids — the initial checked set. */
const defaultComponentIds = COMPONENTS.filter(
  (c) => c.required || c.recommendedDefault
).map((c) => c.id);

/** Default uninstall selection: remove non-destructive machinery only. */
const defaultRemoveIds = DATA_CATEGORIES.filter((c) => !c.destructive).map(
  (c) => c.id
);

const defaultOptions: InstallOptions = {
  destination: PRODUCT.defaultInstallDir,
  createDesktopShortcut: true,
  startAtLogin: false,
  automaticUpdates: true,
  helpImprove: true,
  scope: "current-user",
  fileAssociations: true,
};

/** Interval handle for the running progress simulation. */
let progressTimer: ReturnType<typeof setInterval> | null = null;

function clearProgressTimer() {
  if (progressTimer !== null) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

/**
 * Trigger the backend command for `kind`, using the selections in `state`.
 *
 * `explicitPlan` is supplied when resuming an elevated install, where the
 * plan was assembled by the unelevated instance before the UAC prompt and
 * must be executed verbatim rather than rebuilt from an empty store.
 */
async function dispatch(
  kind: ProgressKind,
  state: WizardState,
  explicitPlan?: InstallPlan
): Promise<void> {
  if (kind === "uninstall") {
    await backend.runUninstall({
      removeIds: state.removeIds,
      exportSettings: state.exportSettings,
      acknowledged: state.acknowledged,
    });
    return;
  }

  if (kind === "update") {
    await backend.runUpdate();
    return;
  }

  if (kind === "repair") {
    await backend.runRepair();
    return;
  }

  const plan =
    explicitPlan ??
    (await backend.resolvePlan(state.options, state.selectedComponents));
  if (!plan) throw new Error("could not resolve the install plan");

  if (kind === "modify") await backend.runModify(plan);
  else await backend.runInstall(plan);
}

/** Build a task list snapshot: first `completed` done, next in progress. */
function snapshot(kind: ProgressKind, completed: number): ProgressState {
  const rows = CHECKLISTS[kind];
  const tasks: ProgressTask[] = rows.map((row, i) => ({
    id: row.id,
    label: row.label,
    state:
      i < completed ? "completed" : i === completed ? "in-progress" : "pending",
  }));
  const done = completed >= rows.length;
  const percent = Math.round((Math.min(completed, rows.length) / rows.length) * 100);
  return { kind, percent, tasks, done };
}

export const useWizardStore = create<WizardState>((set, get) => ({
  flow: "setup",
  step: "welcome",
  history: [],

  options: defaultOptions,
  selectedComponents: defaultComponentIds,
  hydratedFromInstalled: false,

  channel: "stable",
  checkedForUpdates: false,

  removeIds: defaultRemoveIds,
  exportSettings: false,
  acknowledged: false,

  progress: null,
  operationError: null,

  setFlow: (flow) => {
    clearProgressTimer();
    set({
      flow,
      step: FLOW_STEPS[flow][0],
      history: [],
      progress: null,
      operationError: null,
    });
  },

  goToStep: (step) =>
    set((s) => ({ step, history: [...s.history, s.step] })),

  back: () =>
    set((s) => {
      if (s.history.length === 0) return s;
      const history = s.history.slice(0, -1);
      const step = s.history[s.history.length - 1]!;
      return { step, history };
    }),

  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),

  toggleComponent: (id) =>
    set((s) => {
      const component = COMPONENTS.find((c) => c.id === id);
      if (component?.required) return s; // required components can't toggle
      const has = s.selectedComponents.includes(id);
      return {
        selectedComponents: has
          ? s.selectedComponents.filter((c) => c !== id)
          : [...s.selectedComponents, id],
      };
    }),

  hydrateFromInstalled: async () => {
    // Once per run: the Modify step can be left and re-entered, and a
    // second hydrate would throw away the edits the user came back with.
    if (get().hydratedFromInstalled) return;
    set({ hydratedFromInstalled: true });
    // Modify rewrites the manifest and the app's configuration from these,
    // so opening on defaults would silently undo the user's original
    // choices the moment they applied changes.
    const installed = await backend.getInstalledConfiguration();
    if (!installed) return;
    set({
      options: installed.options,
      // A recorded selection can be empty only on a broken manifest; the
      // required components come back from `resolvePlan` either way, so an
      // empty list is safe to take verbatim.
      selectedComponents: installed.selectedComponents,
    });
  },

  setChannel: (channel) => set({ channel }),
  markCheckedForUpdates: () => set({ checkedForUpdates: true }),

  toggleRemove: (id) =>
    set((s) => {
      const has = s.removeIds.includes(id);
      return {
        removeIds: has
          ? s.removeIds.filter((r) => r !== id)
          : [...s.removeIds, id],
      };
    }),

  setExportSettings: (value) => set({ exportSettings: value }),
  setAcknowledged: (value) => set({ acknowledged: value }),

  startOperation: async (kind, landOn, plan) => {
    clearProgressTimer();
    set({ progress: snapshot(kind, 0), operationError: null });

    // No backend in browser preview — walk the checklist on a timer so
    // every screen stays reachable without the Tauri shell.
    if (!hasTauri()) {
      let completed = 0;
      const total = CHECKLISTS[kind].length;
      progressTimer = setInterval(() => {
        completed += 1;
        set({ progress: snapshot(kind, completed) });
        if (completed >= total) {
          clearProgressTimer();
          // Brief hold on 100% so the final check reads before advancing.
          setTimeout(() => get().goToStep(landOn), 650);
        }
      }, 900);
      return;
    }

    // Subscribe before triggering the command: the backend emits its first
    // snapshot synchronously, and a late listener would miss it.
    const unlisten = await backend.onProgress((event) => {
      set({ progress: event });
      if (event.done) {
        unlisten();
        setTimeout(() => get().goToStep(landOn), 650);
      }
    });

    try {
      await dispatch(kind, get(), plan);
    } catch (err) {
      unlisten();
      get().failOperation(err);
    }
  },

  failOperation: (err) => {
    clearProgressTimer();
    const message = err instanceof Error ? err.message : String(err);
    console.error("[installer] operation failed:", message);
    set((s) => ({
      operationError: message,
      // Mark the row that was running as failed and leave the rest as they
      // were, so the checklist shows where it stopped rather than jumping
      // to a misleading 100%.
      progress: s.progress
        ? {
            ...s.progress,
            tasks: s.progress.tasks.map((t) =>
              t.state === "in-progress" ? { ...t, state: "failed" } : t
            ),
          }
        : null,
    }));
  },

  reset: () => {
    clearProgressTimer();
    set({
      flow: "setup",
      step: "welcome",
      history: [],
      options: defaultOptions,
      selectedComponents: defaultComponentIds,
      hydratedFromInstalled: false,
      channel: "stable",
      checkedForUpdates: false,
      removeIds: defaultRemoveIds,
      exportSettings: false,
      acknowledged: false,
      progress: null,
      operationError: null,
    });
  },
}));

// Dev-only: expose the store on `window.__wizard` for debugging and QA
// (driving flows/operations from the console). Stripped from production.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __wizard?: typeof useWizardStore }).__wizard =
    useWizardStore;
}

/** Rail metadata (label + optional lucide icon name) per step. */
export interface RailStep {
  id: StepId;
  label: string;
}

/** The rail rows for the active flow, in display order. */
export function railFor(flow: WizardFlow): RailStep[] {
  // Labels are kept short so they never truncate in the 200px rail.
  const LABELS: Record<StepId, string> = {
    welcome: "Welcome",
    options: "Options",
    components: "Components",
    review: "Review",
    installing: "Installing",
    complete: "Complete",
    maintenance: "Maintenance",
    "check-updates": "Updates",
    "update-available": "Update",
    modify: "Modify",
    applying: "Applying",
    "prepare-uninstall": "Prepare",
    "choose-data": "Choose data",
    "review-removal": "Review",
    uninstalling: "Uninstalling",
  };
  // The uninstall flow reuses the shared hub as its entry step, but a user
  // who launched straight into removal never saw it — showing it in the rail
  // as an already-completed step is misleading, so drop it from this rail.
  const steps =
    flow === "uninstall"
      ? FLOW_STEPS[flow].filter((id) => id !== "maintenance")
      : FLOW_STEPS[flow];
  return steps.map((id) => ({ id, label: LABELS[id] }));
}
