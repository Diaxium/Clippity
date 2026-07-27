import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@app/App";
import "@styles/theme.css";
import "@styles/globals.css";

// Surface anything React's error boundary can't catch — errors in event
// handlers / timers and unhandled rejections from the wizard's many
// fire-and-forget `void someAsync()` calls (window controls, openPath).
window.addEventListener("error", (event) => {
  // eslint-disable-next-line no-console
  console.error("uncaught error", event.message, event.error);
});
window.addEventListener("unhandledrejection", (event) => {
  // eslint-disable-next-line no-console
  console.error("unhandled rejection", event.reason);
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
