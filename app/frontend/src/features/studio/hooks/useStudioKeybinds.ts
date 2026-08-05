import { useEffect } from "react";

import { useStudioStore } from "../state/studioStore";

/** How far the coarse step (Shift + arrow) moves. One second is the
 *  unit people scrub in when they are looking for a moment rather than
 *  placing a cut. */
const COARSE_STEP_MS = 1_000;

/**
 * Studio's keyboard layer.
 *
 * Deliberately the conventional set rather than an invented one — Space,
 * `,`/`.` for frames, `I`/`O` for in and out, `J`/`K`/`L` for the
 * shuttle. Anyone who has used a video tool has these in their fingers,
 * and a capture app is not where someone wants to learn new ones.
 *
 * Not routed through the editor's keybind registry
 * (`features/editor/keybinds`). That registry exists to let the user
 * rebind a hundred-odd annotation commands and to resolve conflicts
 * between them; Studio has nine bindings and no conflicts. Wiring it in
 * would mean teaching the registry about a second surface's context
 * before there is a second surface's worth of commands to justify it.
 */
export function useStudioKeybinds(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal a keystroke from something being typed into. Space
      // in a filename field must be a space.
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }
      // Leave the OS and the app's own accelerators alone.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const store = useStudioStore.getState();
      const { info, playing, range } = store;
      if (!info) return;

      // The same actions the transport's buttons call, so a key and its
      // button cannot drift into doing different things.
      const step = store.stepFrames;
      const nudge = store.nudge;

      switch (event.key) {
        case " ":
        case "k":
        case "K":
          store.setPlaying(!playing);
          break;

        // Frame stepping. Arrows and the `,`/`.` pair both do it —
        // arrows are discoverable, the comma/period pair is what a
        // video editor's muscle memory reaches for.
        case "ArrowLeft":
          if (event.shiftKey) nudge(-COARSE_STEP_MS);
          else step(-1);
          break;
        case "ArrowRight":
          if (event.shiftKey) nudge(COARSE_STEP_MS);
          else step(1);
          break;
        case ",":
          step(-1);
          break;
        case ".":
          step(1);
          break;

        // The shuttle pair. `K` is pause, handled with Space above.
        case "j":
        case "J":
          nudge(-COARSE_STEP_MS);
          break;
        case "l":
        case "L":
          nudge(COARSE_STEP_MS);
          break;

        // In and out at the playhead. Routed through the same resolver
        // the drag uses, so a keypress can no more produce an invalid
        // range than a gesture can.
        case "i":
        case "I":
          store.setHandleToPlayhead("in");
          break;
        case "o":
        case "O":
          store.setHandleToPlayhead("out");
          break;

        // Jump to the edges of the *trim*, not the file. Once handles
        // are placed, they are what the user is working within.
        case "Home":
          store.seek(range.startMs);
          break;
        case "End":
          store.seek(range.endMs);
          break;

        case "m":
        case "M":
          store.setMuted(!store.muted);
          break;

        // Delete the selected annotation. Falls through to the default
        // when nothing is selected, so the key stays available to
        // whatever else might want it rather than being swallowed.
        case "Delete":
        case "Backspace": {
          const { selectedAnnotationId } = store;
          if (!selectedAnnotationId) return;
          store.removeAnnotation(selectedAnnotationId);
          break;
        }

        // Drop the selection, the conventional way out of an edit.
        case "Escape":
          if (!store.selectedAnnotationId) return;
          store.selectAnnotation(null);
          break;

        default:
          return;
      }
      // Only reached when a branch above handled the key — Space must
      // not also scroll the panel behind the player.
      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
