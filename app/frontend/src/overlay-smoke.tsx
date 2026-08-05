/**
 * Overlay design-review / performance harness (dev only).
 *
 * The real region-selection overlay (`OverlayLayout`) needs a Tauri-provided
 * desktop snapshot (`get_desktop_snapshot`) before the magnifier loupe + RGB
 * HUD can render anything. This standalone entry seeds the overlay store with a
 * synthetic snapshot canvas and a cursor so the crosshair, loupe, region drag,
 * and chrome can be exercised — and their per-pointer-move cost measured — in a
 * plain browser via the dev server, with no Tauri runtime.
 *
 * Mirrors `editor-smoke.tsx`. Referenced by `overlay-smoke.html`; not part of
 * the production bundle.
 *
 * `window.__ov` is exposed so a reviewer can drive states from the console /
 * preview tooling, e.g.:
 *   __ov.getState().setMode('region')
 *   __ov.getState().setCursor({ x: 400, y: 300 })
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { OverlayLayout } from "@features/overlay";
import { useOverlayStore } from "@features/overlay/state/overlayStore";

import "@styles/theme.css";
import "@styles/globals.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute(
  "data-theme",
  params.get("theme") === "light" ? "light" : "dark"
);

/**
 * A colorful synthetic "desktop" so the loupe + RGB readout show something
 * recognizable and pixel sampling is verifiable. Drawn at physical-pixel
 * resolution (logical size × dpr) to match the real snapshot, which the
 * magnifier samples via `getImageData(x*dpr, y*dpr, 1, 1)`.
 */
function seedSnapshot(): void {
  const dpr = window.devicePixelRatio || 1;
  // Match the real app: the snapshot covers exactly the overlay window, so the
  // backdrop's 100%/100% stretch is a 1:1 logical mapping (sampling math relies
  // on `canvas.width / dpr === window.innerWidth`).
  const w = window.innerWidth || 1200;
  const h = window.innerHeight || 800;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  g.addColorStop(0, "#1e3a8a");
  g.addColorStop(1, "#9d174d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cols = [
    "#ef4444",
    "#f59e0b",
    "#10b981",
    "#3b82f6",
    "#a855f7",
    "#ffffff",
  ];
  const cell = 80 * dpr;
  let i = 0;
  for (let y = 0; y < canvas.height; y += cell) {
    for (let x = 0; x < canvas.width; x += cell) {
      ctx.fillStyle = cols[i++ % cols.length]!;
      ctx.fillRect(x + cell * 0.2, y + cell * 0.2, cell * 0.6, cell * 0.6);
    }
  }

  useOverlayStore
    .getState()
    .setSnapshot({ url: canvas.toDataURL("image/png"), sampleCtx: ctx });
}

seedSnapshot();
useOverlayStore.getState().setMode("region");
useOverlayStore.getState().setCursor({
  x: Math.round((window.innerWidth || 1200) / 2),
  y: Math.round((window.innerHeight || 800) / 2),
});

// Expose the store for console / preview-tool driving.
(window as unknown as { __ov: typeof useOverlayStore }).__ov = useOverlayStore;

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <OverlayLayout />
  </StrictMode>
);
