import { AlertTriangle, FolderOpen, Film } from "lucide-react";

import { useStudioClip } from "../hooks/useStudioClip";
import { useStudioKeybinds } from "../hooks/useStudioKeybinds";
import { useStudioStore } from "../state/studioStore";
import { AnnotationInspector } from "./AnnotationInspector";
import { ExportBar } from "./ExportBar";
import { Timeline } from "./Timeline";
import { TransportBar } from "./TransportBar";
import { VideoStage } from "./VideoStage";

interface StudioLayoutProps {
  /** Capture id of the recording to open, from the dashboard handoff. */
  id: string | null;
  /** Navigates to the Library view. Provided by the dashboard shell. */
  onOpenLibrary?: () => void;
}

/**
 * Studio — the video surface.
 *
 * A peer of the annotation editor, not a mode of it. The two share a
 * purpose (explain a captured moment) and almost none of their
 * machinery: the editor's document is a scene graph of shapes over a
 * still image, and Studio's is a clip, a playhead and a range. Reuse
 * happens at the level of design tokens (`.clippity-editor` supplies
 * the `--ed-*` family both surfaces read) rather than at the level of
 * state or components, which is the boundary that actually held up
 * when the two were compared.
 *
 * The layout is fixed and deliberately so: picture, then timeline, then
 * transport, top to bottom, with the picture taking whatever is left.
 * A video tool's controls should be where the user's hand already is
 * and should not move as a clip loads.
 */
export function StudioLayout({ id, onOpenLibrary }: StudioLayoutProps) {
  const status = useStudioStore((s) => s.status);
  const error = useStudioStore((s) => s.error);

  useStudioClip(id);
  // Keys are live only with a clip on screen, so Space doesn't get
  // swallowed while the view is showing an empty or error state.
  useStudioKeybinds(status === "ready");

  return (
    <div className="clippity-editor flex h-full w-full flex-col overflow-hidden">
      {status === "ready" ? (
        <>
          <VideoStage />
          <Timeline />
          <TransportBar />
          {/* Above the export row, because it edits the thing being
              exported — and below the transport, so adding an annotation
              never moves the playback controls. */}
          <AnnotationInspector />
          <ExportBar />
        </>
      ) : (
        <StudioPlaceholder
          status={status}
          error={error}
          onOpenLibrary={onOpenLibrary}
        />
      )}
    </div>
  );
}

interface StudioPlaceholderProps {
  status: "idle" | "loading" | "error";
  error: string | null;
  onOpenLibrary?: () => void;
}

/**
 * The three non-playing states, in one component so they share a centre
 * of gravity — a surface whose empty state sits somewhere different from
 * its error state feels like two screens.
 */
function StudioPlaceholder({
  status,
  error,
  onOpenLibrary,
}: StudioPlaceholderProps) {
  if (status === "loading") {
    // No spinner: a probe reads the container's header and returns in
    // milliseconds, so a spinner would be a flash of anxiety rather
    // than information.
    return (
      <div
        className="flex h-full w-full items-center justify-center"
        style={{ background: "var(--ed-canvas)" }}
      >
        <p className="text-[13px]" style={{ color: "var(--ed-text-faint)" }}>
          Opening recording…
        </p>
      </div>
    );
  }

  const failed = status === "error";

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-8 text-center"
      style={{ background: "var(--ed-canvas)" }}
    >
      <div
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{
          background: "var(--ed-panel)",
          color: failed ? "var(--ed-danger)" : "var(--ed-text-dim)",
        }}
      >
        {failed ? (
          <AlertTriangle size={24} strokeWidth={1.5} />
        ) : (
          <Film size={24} strokeWidth={1.5} />
        )}
      </div>
      <p
        className="max-w-sm text-[13px]"
        style={{ color: "var(--ed-text-dim)" }}
      >
        {failed
          ? error
          : "Open a recording from the Library to play and trim it."}
      </p>
      {onOpenLibrary && (
        <button
          type="button"
          onClick={onOpenLibrary}
          className="focus-ring mt-1 inline-flex items-center gap-2 rounded-[10px] border px-3.5 py-2 text-[13px] font-medium transition-colors"
          style={{
            background: "var(--ed-elev)",
            borderColor: "var(--ed-hairline-strong)",
            color: "var(--ed-text)",
          }}
        >
          <FolderOpen size={15} strokeWidth={1.85} />
          Open Library
        </button>
      )}
    </div>
  );
}
