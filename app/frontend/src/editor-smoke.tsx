/**
 * Editor design-review harness (dev only).
 *
 * The real editor (`EditorLayout`) needs a Tauri-backed capture (`editor_load`)
 * to render anything but the empty state. This standalone entry seeds the scene
 * store with a representative annotated screenshot so the editor's chrome,
 * panels, canvas, and overlays can be reviewed (and design changes verified) in
 * a plain browser via the dev server — no Tauri runtime required.
 *
 * Referenced by `editor-smoke.html`. Not part of the production bundle.
 *
 * `window.__ed` is exposed so a reviewer can drive states from the console /
 * preview tooling, e.g.:
 *   __ed.getState().setMode('design')
 *   __ed.getState().select(['<id>'])
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { EditorLayout } from "@features/editor";
import {
  useEditorStore,
  type SceneInit,
} from "@features/editor/state/editorStore";
import {
  defaultFills,
  defaultStrokes,
  makeArrow,
  makeEllipse,
  makeFrame,
  makeImage,
  makeRectangle,
  makeSolidPaint,
  makeText,
  type SceneNode,
} from "@features/editor/types";

import "@styles/theme.css";
import "@styles/globals.css";

// Theme via ?theme=light|dark (Providers normally sets this; default dark to
// match the app's shipped default).
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute(
  "data-theme",
  params.get("theme") === "light" ? "light" : "dark"
);
document.documentElement.setAttribute("data-effects", "flat");

/** A believable product-screenshot mock used as the capture's base image. */
function mockScreenshot(): string {
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="720" viewBox="0 0 1100 720">
  <rect width="1100" height="720" fill="#f3f4f6"/>
  <rect width="1100" height="60" fill="#ffffff"/>
  <circle cx="34" cy="30" r="6" fill="#ff5f57"/><circle cx="56" cy="30" r="6" fill="#febc2e"/><circle cx="78" cy="30" r="6" fill="#28c840"/>
  <rect x="120" y="18" width="420" height="24" rx="12" fill="#eceef1"/>
  <rect x="0" y="60" width="220" height="660" fill="#1f2430"/>
  <rect x="24" y="92" width="150" height="14" rx="7" fill="#3a4252"/>
  <rect x="24" y="132" width="172" height="34" rx="8" fill="#2d6cdf"/>
  <rect x="24" y="178" width="150" height="14" rx="7" fill="#39404e"/>
  <rect x="24" y="214" width="120" height="14" rx="7" fill="#39404e"/>
  <rect x="24" y="250" width="160" height="14" rx="7" fill="#39404e"/>
  <rect x="260" y="96" width="260" height="26" rx="6" fill="#1f2937"/>
  <rect x="260" y="150" width="250" height="150" rx="14" fill="#ffffff"/>
  <rect x="540" y="150" width="250" height="150" rx="14" fill="#ffffff"/>
  <rect x="820" y="150" width="250" height="150" rx="14" fill="#ffffff"/>
  <rect x="284" y="176" width="120" height="14" rx="7" fill="#9aa3b2"/>
  <rect x="284" y="210" width="80" height="40" rx="8" fill="#2d6cdf"/>
  <rect x="564" y="176" width="120" height="14" rx="7" fill="#9aa3b2"/>
  <rect x="564" y="210" width="80" height="40" rx="8" fill="#22a06b"/>
  <rect x="844" y="176" width="120" height="14" rx="7" fill="#9aa3b2"/>
  <rect x="844" y="210" width="80" height="40" rx="8" fill="#e0533d"/>
  <rect x="260" y="330" width="810" height="350" rx="16" fill="#ffffff"/>
  <polyline points="300,600 400,540 500,560 600,470 700,500 820,420 1020,440" fill="none" stroke="#2d6cdf" stroke-width="4"/>
  <rect x="300" y="370" width="200" height="16" rx="8" fill="#cbd2dc"/>
</svg>`.trim();
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function seedScene(): SceneInit {
  const rect = { x: 0, y: 0, width: 1100, height: 720 };
  const frame = makeFrame(rect, {
    name: "Dashboard.png",
    clipContent: true,
    cornerRadius: 0,
  });
  const photo = makeImage(rect, mockScreenshot(), { name: "Screenshot" });
  frame.children = [photo.id];

  // Blur over a sidebar label.
  const blur = makeRectangle(
    { x: 24, y: 152, width: 172, height: 22 },
    { name: "Blur", fills: [] }
  );
  blur.sample = { mode: "blur", amount: 8 };

  // "Redaction" is now just a black-filled rectangle — the dedicated redact tool
  // was removed (a redaction is a black fill; see ADR 0015).
  const redact = makeRectangle(
    { x: 380, y: 78, width: 200, height: 24 },
    { name: "Redaction", fills: [makeSolidPaint("#000000", 1)] }
  );

  // Magnifier loupe over the chart's rising line — exercises the clip fix: the
  // zoomed image must stay inside the ellipse, with the ring as its edge (ADR 0015).
  const magnify = makeEllipse(
    { x: 690, y: 520, width: 150, height: 150 },
    { name: "Magnifier", fills: [], strokes: defaultStrokes("magnify") }
  );
  magnify.sample = { mode: "magnify", amount: 2.4 };

  // Highlighter over the card title.
  const highlight = makeRectangle(
    { x: 540, y: 472, width: 290, height: 30 },
    { name: "Highlight", fills: defaultFills("highlight"), strokes: [] }
  );
  highlight.blendMode = "multiply";

  // Arrow pointing at the rising line.
  const arrow = makeArrow({ x: 470, y: 660, width: 330, height: -210 });

  // Numbered step badge.
  const step = makeEllipse(
    { x: 300, y: 560, width: 44, height: 44 },
    { name: "Step", fills: defaultFills("step"), strokes: [] }
  );
  step.lockAspect = true;
  step.step = { number: 1 };

  // Speech-bubble callout.
  const callout = makeRectangle(
    { x: 770, y: 360, width: 250, height: 92 },
    {
      name: "Callout",
      fills: defaultFills("callout"),
      strokes: defaultStrokes("callout"),
    }
  );
  callout.callout = { angle: 215, length: 46 };

  // Title text.
  const title = makeText(
    { x: 300, y: 96, width: 320, height: 34 },
    {
      name: "Title",
      text: "Q3 revenue up 24%",
      fontSize: 26,
      fontWeight: 700,
      color: "#f24822",
    }
  );

  const nodes: Record<string, SceneNode> = {};
  for (const n of [
    frame,
    photo,
    blur,
    redact,
    magnify,
    highlight,
    arrow,
    step,
    callout,
    title,
  ]) {
    nodes[n.id] = n;
  }

  return {
    rootIds: [
      frame.id,
      blur.id,
      redact.id,
      magnify.id,
      highlight.id,
      arrow.id,
      step.id,
      callout.id,
      title.id,
    ],
    nodes,
    docName: "Dashboard",
    sourceId: "smoke",
    select: [],
  };
}

useEditorStore.getState().loadScene(seedScene());

// Expose the store for console / preview-tool driving.
(window as unknown as { __ed: typeof useEditorStore }).__ed = useEditorStore;

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <div style={{ height: "100vh", width: "100vw" }}>
      <EditorLayout id="smoke" />
    </div>
  </StrictMode>
);
