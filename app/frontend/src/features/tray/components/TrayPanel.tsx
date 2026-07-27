import { useRecentCaptures } from "../hooks/useRecentCaptures";
import { useTrayPanel } from "../hooks/useTrayPanel";
import { CaptureActions } from "./CaptureActions";
import { CaptureControls } from "./CaptureControls";
import { RecentCaptures } from "./RecentCaptures";
import { RepeatLastRegion } from "./RepeatLastRegion";
import { TrayFooter } from "./TrayFooter";
import { TrayHeader } from "./TrayHeader";
import { TrayPresets } from "./TrayPresets";

/**
 * Root of the tray flyout window. A frosted card (Win11 Mica via
 * `chrome::FROSTED_WINDOWS` + the `app-canvas-bg` tint) laid out
 * top-to-bottom: header · capture actions + controls · recent captures ·
 * footer.
 *
 * The backend (`services/tray_service.rs`) positions + shows the window
 * on a tray left-click and emits `clippity://tray/opened`. `useTrayPanel`
 * owns dismissal, the quick capture options, and the action handlers;
 * `useRecentCaptures` owns the recents strip. No `WindowFrame` wrapper —
 * the panel isn't draggable and supplies its own canvas tint + padding.
 */
export function TrayPanel() {
  const {
    actions,
    panelRef,
    firstActionRef,
    toggles,
    setToggle,
    timedSeconds,
    setTimedSeconds,
  } = useTrayPanel();
  const { recents, loading } = useRecentCaptures();

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="app-canvas-bg flex h-screen w-screen flex-col gap-3 overflow-hidden p-3.5 select-none focus:outline-none"
    >
      <TrayHeader onSettings={actions.openSettings} onClose={actions.dismiss} />
      {/* Capture tiles (the 4th opens the full window), the one-shot
          repeat of the last region, and the modifiers (cursor / copy /
          timed) that parameterise all of them. */}
      <div className="flex flex-col gap-2">
        <CaptureActions
          firstActionRef={firstActionRef}
          onFullscreen={actions.fullscreen}
          onWindow={actions.windowCapture}
          onRegion={actions.region}
          onCapture={actions.openCaptureWindow}
        />
        <RepeatLastRegion onClick={actions.repeatLastRegion} />
        <CaptureControls
          cursor={toggles.cursor}
          clipboard={toggles.clipboard}
          timed={toggles.timed}
          onToggle={setToggle}
          timedSeconds={timedSeconds}
          onTimedSecondsChange={setTimedSeconds}
        />
      </div>
      {/* Recents + presets share a scroll area so the fixed-height panel
          can't overflow when several presets exist. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <RecentCaptures
          recents={recents}
          loading={loading}
          onOpen={actions.openRecent}
        />
        <TrayPresets onRun={actions.runPreset} />
      </div>
      <TrayFooter
        onLibrary={actions.openLibrary}
        onEditor={actions.openEditor}
        onQuit={actions.quit}
      />
    </div>
  );
}
