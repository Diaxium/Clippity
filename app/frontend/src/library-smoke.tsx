/**
 * Library design-review harness (dev only).
 *
 * `LibraryLayout` renders nothing but its empty state without a
 * Tauri-backed listing, so unlike `editor-smoke` (which seeds a store
 * directly) this one has to answer IPC: the items arrive through
 * `library_list`, the thumbnails through `library_thumbnail`. The stub
 * below installs `window.__TAURI_INTERNALS__` *before* the app's module
 * graph loads — `@tauri-apps/api/core` reads it at call time, so a plain
 * dev-server page can drive the real component tree with real data.
 *
 * Referenced by `library-smoke.html`. Not part of the production bundle.
 *
 * `window.__lib` is exposed so a reviewer can assert selection state from
 * the console / preview tooling, e.g.:
 *   __lib.getState().selected
 *   __lib.getState().anchorId
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// Surface anything the stub fails to satisfy with a real stack, so a
// harness gap is never mistaken for a bug in the feature under review.
window.addEventListener("unhandledrejection", (e) => {
  console.warn("[library-smoke] unhandled rejection:", e.reason);
});

// ---------- Tauri stub (must run before the app imports) ----------

/** A flat colored tile, so each card is visually distinct. */
function tile(hue: number, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
    <rect width="320" height="180" fill="hsl(${hue} 45% 42%)"/>
    <rect x="0" y="0" width="320" height="34" fill="hsl(${hue} 45% 30%)"/>
    <text x="16" y="104" font-family="sans-serif" font-size="44" font-weight="700"
          fill="rgba(255,255,255,0.92)">${label}</text>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const DAY = 86_400_000;
/** Fixed so the day grouping is stable across reloads. */
const NOW = new Date("2026-07-22T15:00:00Z").getTime();

const CAPTURES = [
  { n: 1, day: 0, app: "Chrome" },
  { n: 2, day: 0, app: "Code" },
  { n: 3, day: 0, app: "Figma" },
  { n: 4, day: 0, app: "Slack" },
  { n: 5, day: 1, app: "Chrome" },
  { n: 6, day: 1, app: "Code" },
  { n: 7, day: 2, app: "Terminal" },
  { n: 8, day: 2, app: "Figma" },
].map((c) => ({
  id: `C:/captures/shot-${String(c.n).padStart(2, "0")}.png`,
  title: `shot-${String(c.n).padStart(2, "0")}`,
  kind: "image" as const,
  createdAtMs: NOW - c.day * DAY - c.n * 600_000,
  sizeBytes: 240_000 + c.n * 11_000,
  trashed: false,
  sourceApp: c.app,
  width: 1280,
  height: 720,
  mode: "Region",
  tags: c.n % 3 === 0 ? ["bug"] : [],
  favorite: c.n === 2,
}));

const THUMBS = new Map(
  CAPTURES.map((c, i) => [c.id, tile(i * 42, String(i + 1))])
);

// Tauri's `listen` unsubscribes through this object rather than through
// `invoke`. StrictMode double-mounts every effect, so the unlisten path
// runs on the first pass and would throw without it.
(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: async () => {},
};

(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (cb: any) => cb,
  invoke: async (command: string, args: any) => {
    switch (command) {
      case "library_list":
        return CAPTURES;
      case "library_thumbnail":
        return THUMBS.get(args?.id) ?? null;
      case "collections_list":
        return [];
      // The event plugin's listen/unlisten handshake — resolve so the
      // `library/updated` subscription mounts without throwing.
      case "plugin:event|listen":
        return 0;
      case "plugin:event|unlisten":
        return null;
      default:
        console.warn("[library-smoke] unstubbed command:", command, args);
        return null;
    }
  },
};

// ---------- App ----------

const { StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LibraryLayout } = await import("@features/library");
const { useLibraryStore } = await import(
  "@features/library/state/libraryStore"
);

await import("@styles/theme.css");
await import("@styles/globals.css");

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute(
  "data-theme",
  params.get("theme") === "light" ? "light" : "dark"
);
document.documentElement.setAttribute("data-effects", "flat");

(window as any).__lib = useLibraryStore;

// Reuse the root across hot updates — this module re-executes on HMR,
// and a second `createRoot` on the same container warns and detaches.
const container = document.getElementById("root")!;
const root = ((window as any).__libRoot ??= createRoot(container));
root.render(
  <StrictMode>
    <div style={{ height: "100vh" }}>
      <LibraryLayout />
    </div>
  </StrictMode>
);
