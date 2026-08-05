/**
 * Studio — the video surface.
 *
 * Playback, scrubbing and trim for a saved recording, as a dashboard
 * view alongside the annotation editor rather than inside it. See
 * `StudioLayout` for why the two are peers.
 */

export { StudioLayout } from "./components/StudioLayout";
export { useStudioStore } from "./state/studioStore";
export type { StudioStatus } from "./state/studioStore";
