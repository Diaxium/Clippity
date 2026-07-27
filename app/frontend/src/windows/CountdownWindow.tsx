import { CountdownLayout } from "@features/countdown";

/**
 * Countdown window — chromeless strip pinned to the bottom of the
 * cursor monitor's work area (i.e. flush with the top of the taskbar).
 * Backend (`services/countdown_service.rs`) positions and shows the
 * window; the rendered layout lives in the countdown feature folder.
 */
export function CountdownWindow() {
  return <CountdownLayout />;
}
