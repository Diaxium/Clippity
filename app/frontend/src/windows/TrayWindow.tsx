import { TrayPanel } from "@features/tray";

/**
 * Tray flyout window — a frosted quick-action panel anchored just above
 * the system-tray icon. The backend (`services/tray_service.rs`)
 * positions + shows the window on a tray left-click and emits
 * `clippity://tray/opened`; the panel UI lives in the tray feature.
 */
export function TrayWindow() {
  return <TrayPanel />;
}
