/**
 * Tray feature — public surface. Only `TrayPanel` is exported; the tray
 * window (`windows/TrayWindow.tsx`) mounts it directly. Anything that
 * needs to drive the tray (hide / quit) imports from
 * `@services/tauri/clients/tray`.
 */

export { TrayPanel } from "./components/TrayPanel";
