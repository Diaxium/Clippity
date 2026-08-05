import { useState } from "react";

import { mediaUrl } from "@services/tauri/clients/media";

import { useStudioPlayer } from "../hooks/useStudioPlayer";
import { useStudioStore } from "../state/studioStore";
import { AnnotationLayer } from "./AnnotationLayer";

/**
 * The picture.
 *
 * A plain `<video>` with its own controls suppressed — the transport and
 * timeline below are the controls, and a second set of native ones
 * would disagree with them about the trim.
 *
 * The stage is a fixed dark field rather than a themed surface. Video is
 * judged against its surroundings, and a light backdrop washes out
 * exactly the dim UI footage a screen recording usually contains; every
 * editor that shows moving pictures makes the same choice for the same
 * reason.
 *
 * The element is held in **state**, not a ref, and handed to
 * `useStudioPlayer` directly. That is what makes the player's effects
 * re-run when the `<video>` mounts or is replaced — see the hook's note
 * on why a ref silently loses its event listeners.
 */
export function VideoStage() {
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const info = useStudioStore((s) => s.info);
  const setPlaying = useStudioStore((s) => s.setPlaying);
  const playing = useStudioStore((s) => s.playing);
  const failed = useStudioStore((s) => s.failed);

  useStudioPlayer(element);

  // Keyed on the token, so switching clips replaces the element rather
  // than mutating one that is mid-playback.
  const src = info ? mediaUrl(info.token) : undefined;

  return (
    <div
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      style={{ background: "#0b0e14" }}
      onDoubleClick={() => setPlaying(!playing)}
    >
      {src ? (
        <video
          ref={setElement}
          key={src}
          src={src}
          // The transport below is the control surface; native controls
          // would offer a second, conflicting answer about where the
          // clip starts and ends.
          controls={false}
          // Nothing here loops on its own — `nextPlayheadWithinRange`
          // owns looping, and it loops the *trim*, not the file.
          loop={false}
          playsInline
          // Metadata only: the browser fetches the container's header,
          // which is all that is needed to show the first frame. Asking
          // for `auto` would have it pull the whole recording through
          // the scheme handler before the user pressed anything.
          preload="metadata"
          className="max-h-full max-w-full object-contain"
          style={{
            // Reserve the clip's aspect ratio before the first frame
            // decodes, so opening one doesn't reflow the timeline under
            // it.
            aspectRatio: `${info?.width ?? 16} / ${info?.height ?? 9}`,
          }}
          onError={() =>
            failed(
              "The recording could not be played. It may have been moved or deleted."
            )
          }
        />
      ) : null}

      {/* Over the picture, sharing the same element the player drives —
          the redaction preview has to read the frames actually being
          decoded, not a second copy of the clip. */}
      {src ? <AnnotationLayer video={element} /> : null}
    </div>
  );
}
