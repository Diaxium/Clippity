/**
 * Typed wrappers over the installer's Tauri commands.
 *
 * Every call goes through `invoke` from `./tauri`, which resolves
 * `undefined` outside the Tauri shell. That is what lets the whole wizard
 * stay previewable in a plain browser: callers treat `undefined` as "no
 * backend here" and fall back to the local simulation, rather than
 * branching on `hasTauri()` at each site.
 */

import type {
  Detection,
  InstalledConfiguration,
  InstallOptions,
  InstallPlan,
  LaunchRoute,
  ProgressEvent,
  RemovalSelection,
} from "@clippity/installer-shared";

import { hasTauri, invoke } from "./tauri";

/** The event name the Rust services stream progress snapshots over. */
const PROGRESS_EVENT = "installer://progress";

/**
 * Detect whether (and how) Clippity is installed, by correlating the
 * on-disk manifest, the Add/Remove Programs entry, and the installed
 * executable. Resolves `undefined` in browser preview (no backend to ask),
 * where callers fall back to the static catalog snapshot.
 */
export function detectInstallation(): Promise<Detection | undefined> {
  return invoke<Detection>("detect_installation");
}

/**
 * The options + components the installed copy was made with, so the Modify
 * step opens on what is actually installed rather than on the wizard's
 * defaults. `null` when nothing is installed, when the manifest is
 * unreadable, or in browser preview.
 */
export async function getInstalledConfiguration(): Promise<InstalledConfiguration | null> {
  return (
    (await invoke<InstalledConfiguration | null>(
      "get_installed_configuration"
    )) ?? null
  );
}

/** Resolve a full install plan from the user's options + selection. */
export function resolvePlan(
  options: InstallOptions,
  selected: string[]
): Promise<InstallPlan | undefined> {
  return invoke<InstallPlan>("resolve_plan", { options, selected });
}

/**
 * Whether executing `plan` needs an elevated relaunch first.
 *
 * False in preview (no backend to ask), which keeps the browser
 * simulation on the straight-through path.
 */
export async function planRequiresElevation(
  plan: InstallPlan
): Promise<boolean> {
  return (await invoke<boolean>("plan_requires_elevation", { plan })) ?? false;
}

/**
 * Relaunch elevated to execute `plan`, then close this window.
 *
 * The elevated copy picks the plan up through [`takePendingPlan`]. Both
 * processes must never run an install at once, so the close is part of
 * this call rather than left to the caller.
 */
export async function elevateAndInstall(plan: InstallPlan): Promise<void> {
  await invoke<void>("elevate_and_install", { plan });
  const { closeWindow } = await import("./tauri");
  await closeWindow();
}

/**
 * The plan this process was launched to resume after elevation, if any.
 * Consumed on first read, so calling it twice yields `null` the second
 * time.
 */
export async function takePendingPlan(): Promise<InstallPlan | null> {
  return (await invoke<InstallPlan | null>("take_pending_plan")) ?? null;
}

/** Start a fresh install. Progress arrives via [`onProgress`]. */
export function runInstall(plan: InstallPlan): Promise<void | undefined> {
  return invoke<void>("run_install", { plan });
}

/** Apply a modification to an existing install. */
export function runModify(plan: InstallPlan): Promise<void | undefined> {
  return invoke<void>("run_modify", { plan });
}

/** Repair the installed copy (restore missing/corrupt owned files). */
export function runRepair(): Promise<void | undefined> {
  return invoke<void>("run_repair");
}

/** Real filesystem targets the Complete / maintenance screens open. */
export interface MaintenancePaths {
  /** Install directory — what "Open folder" opens. */
  appDir: string;
  /** Retained user-data root — what "Open retained data folder" opens. */
  dataDir: string;
  /** This run's log file — what "View log" opens. */
  logFile: string;
}

/**
 * The concrete paths the Complete and maintenance-hub buttons open.
 * `null` in browser preview (no backend), where those buttons no-op.
 */
export async function getMaintenancePaths(): Promise<MaintenancePaths | null> {
  return (await invoke<MaintenancePaths>("maintenance_paths")) ?? null;
}

/** Launch the installed application (no-op in preview). */
export async function launchApp(): Promise<void> {
  await invoke<void>("launch_app");
}

/** Download and apply the latest update. */
export function runUpdate(): Promise<void | undefined> {
  return invoke<void>("run_update");
}

/**
 * Where the window should start when launched from the Add/Remove Programs
 * Uninstall / Modify buttons. `null` (the default in browser preview and
 * for a plain setup launch) leaves routing to the hash router.
 */
export async function getLaunchRoute(): Promise<LaunchRoute | null> {
  return (await invoke<LaunchRoute | null>("get_launch_route")) ?? null;
}

/**
 * Whether removing the installed copy needs an elevated relaunch first
 * (an all-users install, or one under a protected location this process
 * cannot delete). False in preview, keeping the browser simulation on the
 * straight-through path.
 */
export async function uninstallRequiresElevation(): Promise<boolean> {
  return (await invoke<boolean>("uninstall_requires_elevation")) ?? false;
}

/**
 * Relaunch elevated to remove Clippity per `selection`, then close this
 * window. The elevated copy picks the selection up through
 * [`takePendingRemoval`]; both processes must never run a removal at once,
 * so the close is part of this call.
 */
export async function elevateAndUninstall(
  selection: RemovalSelection
): Promise<void> {
  await invoke<void>("elevate_and_uninstall", { selection });
  const { closeWindow } = await import("./tauri");
  await closeWindow();
}

/**
 * The removal selection this process was launched to resume after
 * elevation, if any. Consumed on first read.
 */
export async function takePendingRemoval(): Promise<RemovalSelection | null> {
  return (await invoke<RemovalSelection | null>("take_pending_removal")) ?? null;
}

/** Remove Clippity per the user's data-removal selection. */
export function runUninstall(
  selection: RemovalSelection
): Promise<void | undefined> {
  return invoke<void>("run_uninstall", { selection });
}

/**
 * Subscribe to backend progress snapshots.
 *
 * Returns an unsubscribe function — a no-op in preview, where no events
 * are ever emitted. Callers must await this before triggering the
 * operation, or the first snapshots are missed.
 */
export async function onProgress(
  handler: (event: ProgressEvent) => void
): Promise<() => void> {
  if (!hasTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<ProgressEvent>(PROGRESS_EVENT, (e) =>
    handler(e.payload)
  );
  return unlisten;
}
