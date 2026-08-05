import { lazy, type ComponentType } from "react";

import { ROUTES } from "@config/constants";

/**
 * Each window is a separate lazy chunk. Every Tauri window loads the
 * same bundle and selects its component via the hash route, so without
 * splitting, the tray/toast/countdown windows would all download the
 * editor-heavy MainWindow code they never render. `lazy()` peels each
 * window into its own chunk that only loads for the matching route.
 *
 * The modules use named exports, so each import is remapped to the
 * `{ default }` shape `lazy()` expects.
 */
const CaptureWindow = lazy(() =>
  import("@windows/CaptureWindow").then((m) => ({ default: m.CaptureWindow }))
);
const CountdownWindow = lazy(() =>
  import("@windows/CountdownWindow").then((m) => ({
    default: m.CountdownWindow,
  }))
);
const MainWindow = lazy(() =>
  import("@windows/MainWindow").then((m) => ({ default: m.MainWindow }))
);
const OverlayWindow = lazy(() =>
  import("@windows/OverlayWindow").then((m) => ({ default: m.OverlayWindow }))
);
const ToastWindow = lazy(() =>
  import("@windows/ToastWindow").then((m) => ({ default: m.ToastWindow }))
);
const TrayWindow = lazy(() =>
  import("@windows/TrayWindow").then((m) => ({ default: m.TrayWindow }))
);
const RecorderFrameWindow = lazy(() =>
  import("@windows/RecorderFrameWindow").then((m) => ({
    default: m.RecorderFrameWindow,
  }))
);

/**
 * Hash-prefix → window component. Matched longest-prefix-first so a
 * sub-route like `/main/library` still resolves to MainWindow (which
 * then handles its own internal routing).
 */
const ROUTE_TABLE: ReadonlyArray<[string, ComponentType]> = [
  [ROUTES.overlay, OverlayWindow],
  [ROUTES.countdown, CountdownWindow],
  [ROUTES.toast, ToastWindow],
  [ROUTES.tray, TrayWindow],
  [ROUTES.recorderFrame, RecorderFrameWindow],
  [ROUTES.main, MainWindow],
  [ROUTES.capture, CaptureWindow], // default — must come last
];

export function resolveWindow(route: string): ComponentType {
  for (const [prefix, Component] of ROUTE_TABLE) {
    if (prefix === "") {
      // The empty/root route always matches; only reached if nothing
      // above matched first.
      return Component;
    }
    if (route.startsWith(prefix)) return Component;
  }
  return CaptureWindow;
}
