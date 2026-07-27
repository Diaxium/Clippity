/**
 * Thin bridge to the Tauri backend.
 *
 * The wizard runs in two environments: inside the real Tauri shell (where
 * `invoke` reaches the Rust commands and window controls work) and in a
 * plain browser preview (where none of that exists). Every helper here
 * detects Tauri once and degrades to a safe no-op / simulation in the
 * browser, so the same components render in both — mirroring the main
 * app's "getSettings returns null in preview" pattern.
 */

/** True when the Tauri runtime is present in this window. */
export function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Invoke a Tauri command, or resolve `undefined` in browser preview. */
export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T | undefined> {
  if (!hasTauri()) return undefined;
  const api = await import("@tauri-apps/api/core");
  return api.invoke<T>(cmd, args);
}

/** Minimize the current window (no-op in preview). */
export async function minimizeWindow(): Promise<void> {
  if (!hasTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

/** Toggle-maximize the current window (no-op in preview). */
export async function toggleMaximizeWindow(): Promise<void> {
  if (!hasTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().toggleMaximize();
}

/** Close the current window (no-op in preview). */
export async function closeWindow(): Promise<void> {
  if (!hasTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/** Open a path / URL with the OS default handler (no-op in preview). */
export async function openPath(target: string): Promise<void> {
  if (!hasTauri()) return;
  const { openPath: open } = await import("@tauri-apps/plugin-opener");
  await open(target);
}
