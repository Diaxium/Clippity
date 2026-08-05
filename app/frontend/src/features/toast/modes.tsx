import type { JSX } from "react";

import { ClipboardToastBody } from "./components/ClipboardToastBody";
import { ColorToastBody } from "./components/ColorToastBody";
import { ErrorToastBody } from "./components/ErrorToastBody";
import { PaletteToastBody } from "./components/PaletteToastBody";
import { RecorderToastBody } from "./components/RecorderToastBody";
import { RecordingToastBody } from "./components/RecordingToastBody";
import { TextToastBody } from "./components/TextToastBody";
import { UnknownKindBody } from "./components/UnknownKindBody";
import type { ToastPayload } from "./types";

/**
 * Strategy dispatch from `kind` → body component.
 *
 * `error`, `clipboard`, `color`, `palette`, `text`, and `recording`
 * render real bodies. Every other (reserved-but-unported) kind routes
 * through `<UnknownKindBody>` — a deliberately-visible fallback so a
 * runaway emit during development is loud, not silent. A future port
 * flips its `case` from the `default` fallback when it lands.
 */
/**
 * Kinds whose body renders its **own** floating cards and owns its own
 * controls — the two long-running session HUDs.
 *
 * `ToastLayout` drops the standard toast card, its padding and its
 * chrome for these: wrapping them would nest a card inside a card, clip
 * the result, and put a ✕ over a HUD whose dismissal must go through
 * its own Stop/Discard (a UI-only dismiss would orphan the worker).
 *
 * Lives beside the dispatch table rather than inline in the layout so
 * adding a body and forgetting the exemption is one change, not two —
 * which is exactly how the recorder HUD first shipped squeezed into the
 * ordinary toast shell.
 */
export function rendersOwnChrome(kind: ToastPayload["kind"]): boolean {
  return kind === "recording" || kind === "recorder";
}

export function renderBody(payload: ToastPayload): JSX.Element {
  switch (payload.kind) {
    case "error":
      return <ErrorToastBody message={payload.message} />;
    case "clipboard":
      return (
        <ClipboardToastBody
          preview={payload.preview}
          width={payload.width}
          height={payload.height}
          text={payload.text}
        />
      );
    case "color":
      return <ColorToastBody color={payload.color} />;
    case "palette":
      return (
        <PaletteToastBody preview={payload.preview} colors={payload.colors} />
      );
    case "text":
      return <TextToastBody text={payload.text} />;
    case "recording":
      return <RecordingToastBody mode={payload.mode} frames={payload.frames} />;
    case "recorder":
      return (
        <RecorderToastBody
          format={payload.format}
          microphone={payload.microphone}
          system={payload.system}
        />
      );
    default:
      // Every current `kind` has a real body above, so `payload` narrows
      // to `never` here — the cast keeps a defensive fallback for a
      // malformed / future-reserved emit (e.g. via devtools or a test
      // harness) rather than rendering nothing.
      return <UnknownKindBody kind={(payload as ToastPayload).kind} />;
  }
}
