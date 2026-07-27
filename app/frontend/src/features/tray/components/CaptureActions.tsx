import { type Ref } from "react";
import { AppWindow, Camera, Crop, Maximize } from "lucide-react";

import { CaptureTile } from "./CaptureTile";

interface CaptureActionsProps {
  /** Forwarded to the first tile so the panel can focus it on open. */
  firstActionRef: Ref<HTMLButtonElement>;
  onFullscreen: () => void;
  onWindow: () => void;
  onRegion: () => void;
  onCapture: () => void;
}

/**
 * The capture entry points, in a single compact row. Fullscreen grabs
 * immediately; Region + Window open the overlay; the Timed delay is a
 * modifier set in `CaptureControls` (it applies to all three). The fourth
 * tile is the primary "Capture" action — it opens the full capture window
 * (the roomy hub with every option + the custom modes) and so wears the
 * slate primary chip, which is why Fullscreen no longer does.
 */
export function CaptureActions({
  firstActionRef,
  onFullscreen,
  onWindow,
  onRegion,
  onCapture,
}: CaptureActionsProps) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      <CaptureTile
        ref={firstActionRef}
        icon={Maximize}
        label="Fullscreen"
        hint="Capture the whole screen"
        tint="warm"
        onClick={onFullscreen}
      />
      <CaptureTile
        icon={AppWindow}
        label="Window"
        hint="Pick a single window to capture"
        tint="cool"
        onClick={onWindow}
      />
      <CaptureTile
        icon={Crop}
        label="Region"
        hint="Select a region to capture"
        tint="warm"
        onClick={onRegion}
      />
      <CaptureTile
        icon={Camera}
        label="Capture"
        hint="Open the full capture window"
        tint="primary"
        onClick={onCapture}
      />
    </div>
  );
}
