/**
 * Capture wire-format contracts — mirror Rust `domain::capture`.
 */

export type CaptureType = "region" | "window" | "fullscreen" | "custom";

export type CustomMode =
  | "object"
  | "multi-area"
  | "freehand"
  | "clipboard"
  | "scrolling-window"
  | "panoramic"
  | "grab-text"
  | "color-picker"
  | "palette-capture";

export interface CaptureToggles {
  preview: boolean;
  clipboard: boolean;
  cursor: boolean;
  /** Run the backend's Smart-enhance pass (auto-levels + a light
   *  unsharp mask) before encoding. Rust `domain::enhance`; mirrors
   *  `OverlayToggles.enhance`. */
  enhance: boolean;
}

export interface CaptureDelay {
  seconds: number;
}

/** Payload sent to the backend's `capture_fullscreen` command. */
export interface CaptureRequest {
  type: CaptureType;
  customMode: CustomMode | null;
  toggles: CaptureToggles;
  delay: CaptureDelay | null;
  effect: string | null;
  share: string | null;
  /** Optional save-directory override (preset "save to"). Omitted /
   *  null = the live captures dir. Mirrors Rust `output_dir`. */
  outputDir?: string | null;
  /** Name of the preset running this capture, recorded in its
   *  provenance sidecar. Omitted / null = an interactive capture.
   *
   *  The one provenance field the backend cannot observe for itself:
   *  presets run through `runPreset`, which dispatches the ordinary
   *  capture commands, so which preset is executing is only knowable
   *  at dispatch. Stamped there, never stored on the preset — that way
   *  renaming a preset can't leave a stale name behind. */
  preset?: string | null;
}

/** What the backend returns and what the `capture/finished` event carries. */
export interface CaptureResult {
  id: string;
  type: CaptureType;
  customMode: CustomMode | null;
  width: number;
  height: number;
  /** Absolute on-disk path to the saved PNG. */
  path: string;
  /** Whether the user asked to open this capture in the editor (the
   *  "Preview in Editor" toggle). Carried on `capture/finished` so the
   *  main window's persistent listener can open the editor uniformly
   *  across every capture mode + dispatch path. */
  preview: boolean;
}

/**
 * Outcome of a Clipboard custom-mode ingest (mirrors Rust
 * `domain::capture::ClipboardIngest`). Discriminated on `kind`:
 * - `image` — the clipboard held a bitmap; it was saved as a capture
 *   (the backend already emitted `capture/finished` + `library/updated`
 *   and raised a `clipboard` toast).
 * - `text` — the clipboard held text; persisted as an aux library entry.
 * - `empty` — nothing usable; the caller shows a "copy something first"
 *   toast.
 */
export type ClipboardIngest =
  | { kind: "image"; capture: CaptureResult }
  | { kind: "text"; text: string }
  | { kind: "empty" };
