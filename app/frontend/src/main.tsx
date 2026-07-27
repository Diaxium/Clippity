import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@app/App";
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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
