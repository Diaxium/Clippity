/**
 * Native folder-picker bridge for the destination selector.
 *
 * Under Tauri this opens the OS directory dialog; in browser preview it
 * returns `null` (the caller keeps the current destination), so the
 * Browse button is inert rather than broken.
 */

import { hasTauri } from "./tauri";

/** Open a directory picker seeded at `current`; resolve the chosen path. */
export async function openBrowseDialog(
  current: string
): Promise<string | null> {
  if (!hasTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: true,
    multiple: false,
    defaultPath: current,
    title: "Choose install location",
  });
  return typeof picked === "string" ? picked : null;
}
