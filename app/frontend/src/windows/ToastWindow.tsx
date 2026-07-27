import { ToastLayout } from "@features/toast";

/**
 * Toast HUD — bottom-corner notification window pinned to the
 * cursor's monitor. Renders an `<ErrorToastBody>` for the MVP-armable
 * `error` variant; reserved kinds route through `<UnknownKindBody>`.
 *
 * The feature folder owns the chrome (Focus + Dismiss buttons), the
 * progress bar, the auto-dismiss timer with hover-pause, and the
 * ResizeObserver-driven resize IPC. This window file is intentionally
 * a 3-line render — composition only.
 */
export function ToastWindow() {
  return <ToastLayout />;
}
