import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@app/App";
import { applyInitialAppearance } from "@app/initialAppearance";
import { useSettingsStore } from "@features/settings";
import { isTauriContext } from "@services/tauri";
import { getSettings } from "@services/tauri/clients/settings";
import { createLogger } from "@shared/lib/logger";
import "@styles/theme.css";
import "@styles/globals.css";

const log = createLogger("window");

// Catch what React's error boundary can't: errors thrown outside the
// render cycle (event handlers, timers) and unhandled promise rejections
// — including the app's many fire-and-forget `void someAsync()` calls
// (e.g. `void emitErrorToast(...)`). Without these listeners such
// failures vanish with no trace anywhere.
window.addEventListener("error", (event) => {
  log.error("uncaught error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    col: event.colno,
    error:
      event.error instanceof Error
        ? { name: event.error.name, message: event.error.message }
        : undefined,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  log.error("unhandled promise rejection", event.reason);
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found in index.html");
}
const root = createRoot(container);

async function start() {
  // Give the bare document the OS-derived fallback immediately. In the desktop
  // app, hydrate the persisted snapshot before mounting React so the first UI
  // frame already has the user's theme, motion, icon, and accent values.
  applyInitialAppearance();
  if (isTauriContext()) {
    try {
      const settings = await getSettings();
      useSettingsStore.getState().setSettings(settings);
      applyInitialAppearance(settings);
    } catch (error) {
      // Providers retries through its normal settings hydration after mount.
      // Rendering the OS-themed fallback is preferable to blocking startup.
      log.warn("could not hydrate appearance before first render", error);
    }
  }

  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void start();
