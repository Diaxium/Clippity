import { useEffect } from "react";

import { EditorDocTitle, EditorLayout } from "@features/editor";
import { HomeLayout } from "@features/home";
import { LibraryLayout, PaletteView } from "@features/library";
import { PresetsLayout } from "@features/presets";
import { SettingsLayout } from "@features/settings";
import {
  consumePendingDashboardView,
  onDashboardView,
} from "@services/tauri/clients/dashboard";
import { TitleBar, WindowFrame } from "@shared/ui";

import { useOpenEditorOnPreview } from "../hooks/useOpenEditorOnPreview";
import { useDashboardStore } from "../state/dashboardStore";
import { DashboardSidebar } from "./DashboardSidebar";

/**
 * Main window root — the dashboard. Owns the active view + the
 * editor's loaded capture id; renders Library / Editor / Settings
 * as internal views, matching the legacy MainWindow pattern.
 *
 * Cross-window handoff:
 *  - On mount, drains `consume_pending_dashboard_view` so a click
 *    from the library that opened this window for the first time
 *    lands on the correct view (race-free vs. an event-only flow).
 *  - Subscribes to `clippity://dashboard/view` for runtime switches
 *    while the dashboard is already shown.
 */
export function DashboardLayout() {
  const view = useDashboardStore((s) => s.view);
  const setView = useDashboardStore((s) => s.setView);
  const sidebarCollapsed = useDashboardStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useDashboardStore((s) => s.setSidebarCollapsed);
  const editorCaptureId = useDashboardStore((s) => s.editorCaptureId);
  const paletteId = useDashboardStore((s) => s.paletteId);
  // The palette view is library-adjacent and has no nav row of its own —
  // keep the Library rail item highlighted while it's open.
  const navActive = view === "palette" ? "library" : view;

  // Drain any pending request stashed by the opening window. Runs
  // once on mount — subsequent runtime switches come through the
  // event listener below.
  useEffect(() => {
    void consumePendingDashboardView().then((req) => {
      if (req) setView(req.view, req.captureId);
    });
  }, [setView]);

  // Runtime view switches (already-shown case).
  useEffect(() => {
    return onDashboardView(({ view: next, captureId }) =>
      setView(next, captureId)
    );
  }, [setView]);

  // Open the editor whenever a capture finishes with its "Preview in
  // Editor" toggle on — single, always-mounted listener for every mode
  // + entry point (the main window is built at startup and never closed).
  useOpenEditorOnPreview();

  return (
    <WindowFrame padding="none">
      <div className="app-canvas-bg flex h-full flex-col">
        <TitleBar
          className="titlebar-neo relative z-30"
          onMenu={() => setSidebarCollapsed(!sidebarCollapsed)}
          sidebarOpen={!sidebarCollapsed}
        >
          {view === "editor" && <EditorDocTitle />}
        </TitleBar>

        <div className="flex flex-1 overflow-hidden">
          <DashboardSidebar
            active={navActive}
            onChange={(v) => setView(v)}
            collapsed={sidebarCollapsed}
          />

          {/* will-change-transform: own compositor layer so the content's
              per-frame repaint during the sidebar collapse stays isolated
              (the window is transparent → WebView2 software-paints). */}
          <div className="flex flex-1 flex-col overflow-hidden will-change-transform">
            <div className="content-canvas relative z-0 m-2.5 flex flex-1 flex-col overflow-hidden rounded-[16px]">
              {view === "home" && (
                <HomeLayout onNavigate={(v, id) => setView(v, id)} />
              )}
              {view === "library" && <LibraryLayout />}
              {view === "editor" && (
                <EditorLayout
                  id={editorCaptureId}
                  onOpenLibrary={() => setView("library")}
                />
              )}
              {view === "settings" && <SettingsLayout />}
              {view === "presets" && <PresetsLayout />}
              {view === "palette" && (
                <PaletteView
                  id={paletteId}
                  onBack={() => setView("library")}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}
