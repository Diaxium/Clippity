import { openDashboard } from "@services/tauri/clients/dashboard";
import { TitleBar, WindowFrame } from "@shared/ui";

import { useCaptureStore } from "../state/captureStore";
import { useCaptureDefaults } from "../hooks/useCaptureDefaults";
import { useCaptureWorkflow } from "../hooks/useCaptureWorkflow";
import { useSpaceTrigger } from "../hooks/useSpaceTrigger";

import { CaptureSidebar } from "./CaptureSidebar";
import { CaptureTypeGrid } from "./CaptureTypeGrid";
import { CustomModesPanel } from "./CustomModesPanel";
import { CaptureOptionsPanel } from "./CaptureOptionsPanel";
import { OutputControls } from "./OutputControls";
import { CaptureFooter } from "./CaptureFooter";
import { CompactCaptureRow } from "./CompactCaptureRow";
import { ComingSoon } from "./ComingSoon";
import { CollapsibleSection } from "./CollapsibleSection";
import { RecordFooter } from "./RecordFooter";
import { RecordOptionsPanel } from "./RecordOptionsPanel";
import { RecordFormatGrid, RecordTypeGrid } from "./RecordTypeGrid";
import { useRecordWorkflow } from "../hooks/useRecordWorkflow";

/**
 * Capture-window root composition. Subscribes to the feature store's
 * `nav`, `sidebarCollapsed`, and `captureType` slices; renders the
 * matching layout. All business logic lives in `useCaptureWorkflow`
 * (trigger) and the store (state); this component is structural.
 *
 * Compact mode is intentionally unreachable in MVP — `compact` is
 * always false. Authored here because the trigger wires for it
 * (settings port #6) will land in a follow-up port without rewriting
 * this composition.
 */
export function CaptureLayout() {
  const nav = useCaptureStore((s) => s.nav);
  const setNav = useCaptureStore((s) => s.setNav);
  const captureType = useCaptureStore((s) => s.captureType);
  const sidebarCollapsed = useCaptureStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useCaptureStore((s) => s.setSidebarCollapsed);

  // Compact mode lives in settings; the path to flip it isn't ported
  // yet (see REBUILD.md tech-debt). The layout below already handles
  // the compact branch — wiring it back on later is a one-line
  // mirror-from-settings change.
  const compact = false;
  const effectiveCollapsed = compact || sidebarCollapsed;

  // Seed the per-session option toggles from the user's persisted
  // capture defaults (Settings → Capture) the first time settings land.
  useCaptureDefaults();

  const workflow = useCaptureWorkflow();
  const recordWorkflow = useRecordWorkflow();
  // One Space binding, routed by which screen is showing — the two
  // screens share the shortcut rather than fighting over it.
  useSpaceTrigger(() => {
    void (nav === "record" ? recordWorkflow.trigger() : workflow.trigger());
  });

  // History + Settings live in the dashboard window now. A click on
  // those sidebar items focuses the dashboard and switches its view;
  // the capture window stays on `capture` so the user can come back
  // to it without losing form state.
  const handleNavChange = (next: typeof nav) => {
    if (next === "history") {
      void openDashboard("library");
      return;
    }
    // Presets are managed in the dashboard (like History/Settings); the
    // capture tab is a launcher into that view rather than an in-window
    // panel.
    if (next === "presets") {
      void openDashboard("presets");
      return;
    }
    setNav(next);
  };

  return (
    <WindowFrame padding="none">
      <div className="app-canvas-bg flex h-full flex-col">
        <TitleBar
          className="titlebar-neo relative z-30"
          onMenu={() => setSidebarCollapsed(!sidebarCollapsed)}
          sidebarOpen={!sidebarCollapsed}
        />

        <div className="flex flex-1 overflow-hidden">
          <CaptureSidebar
            active={nav}
            onChange={handleNavChange}
            onOpenSettings={() => void openDashboard("settings")}
            collapsed={effectiveCollapsed}
          />

          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="content-canvas relative z-0 m-2.5 flex flex-1 flex-col overflow-hidden rounded-[16px]">
              {nav === "record" ? (
                <div className="-mr-2 flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4 pr-4 pb-1">
                  <CollapsibleSection n={1} title="Recording Type">
                    <RecordTypeGrid />
                  </CollapsibleSection>

                  <CollapsibleSection n={2} title="Format">
                    <RecordFormatGrid />
                  </CollapsibleSection>

                  <RecordOptionsPanel
                    startIndex={3}
                    onOpenSettings={() => void openDashboard("settings")}
                  />
                </div>
              ) : nav !== "capture" ? (
                <ComingSoon section={nav} />
              ) : compact ? (
                <CompactCaptureRow />
              ) : (
                <div className="-mr-2 flex flex-1 flex-col gap-4 overflow-y-auto px-6 py-4 pr-4 pb-1">
                  <CollapsibleSection n={1} title="Capture Type">
                    <CaptureTypeGrid />
                  </CollapsibleSection>

                  {captureType === "custom" && (
                    <CustomModesPanel startIndex={2} />
                  )}

                  <CaptureOptionsPanel
                    startIndex={captureType === "custom" ? 3 : 2}
                    onOpenSettings={() => void openDashboard("settings")}
                  />

                  <OutputControls
                    startIndex={captureType === "custom" ? 4 : 3}
                  />
                </div>
              )}
            </div>

            {nav === "capture" && (
              <CaptureFooter
                onCapture={() => void workflow.trigger()}
                compact={compact}
              />
            )}
            {nav === "record" && (
              <RecordFooter
                onRecord={() => void recordWorkflow.trigger()}
                compact={compact}
              />
            )}
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}
