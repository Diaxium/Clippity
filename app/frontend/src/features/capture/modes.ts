/**
 * Capture-mode taxonomy + pure helpers.
 *
 * Source of truth for:
 *   - which capture types and custom modes the UI knows about,
 *   - which are armable in the current build (`AVAILABLE_*`),
 *   - which options are meaningful for a given mode (`visibleOptionKeys`).
 *
 * No React, no Zustand, no IPC. Unit-testable in isolation.
 */

import {
  AppWindow,
  Clipboard,
  Crop,
  Frame,
  LayoutGrid,
  Maximize,
  Palette,
  Pipette,
  ScanEye,
  ScanText,
  Scroll,
  SquarePen,
} from "lucide-react";

import type { CaptureType, CustomMode, CaptureToggles, ModeDef } from "./types";
import type { OverlayMode } from "@services/tauri/clients/overlay";
import type { Capabilities } from "@services/tauri/clients/provisioning";

/** Initial toggle state for a fresh capture window. */
export const DEFAULT_TOGGLES: CaptureToggles & { delay: boolean } = {
  preview: true,
  clipboard: false,
  cursor: false,
  // Off by default: enhancement is a judgement call about the pixels,
  // and a screenshot tool's baseline promise is "what you saw".
  enhance: false,
  delay: false,
};

/** Top-level capture types — the 2×2 grid. */
export const CAPTURE_TYPES: readonly ModeDef<CaptureType>[] = [
  {
    id: "region",
    label: "Region",
    icon: Crop,
    tint: "warm",
    available: true,
  },
  {
    id: "window",
    label: "Window",
    icon: AppWindow,
    tint: "cool",
    available: true,
  },
  {
    id: "fullscreen",
    label: "Fullscreen",
    icon: Maximize,
    tint: "warm",
    available: true,
  },
  {
    id: "custom",
    label: "Custom",
    icon: SquarePen,
    tint: "cool",
    available: true,
  },
];

/** Standard-tier custom modes — top of the custom panel. */
export const CUSTOM_MODES_STANDARD: readonly ModeDef<CustomMode>[] = [
  {
    id: "object",
    label: "Object",
    desc: "On-device AI spots objects and UI elements — click one to capture it.",
    bestFor: ["Buttons & icons", "UI elements", "Dialogs", "Quick captures"],
    icon: ScanEye,
    tint: "warm",
    available: true,
  },
  {
    id: "multi-area",
    label: "Multi-Area",
    desc: "Capture multiple separate regions in one session.",
    bestFor: ["Documentation", "UI comparisons", "Tutorials", "Bug reports"],
    icon: LayoutGrid,
    tint: "cool",
    available: true,
  },
  {
    id: "clipboard",
    label: "Clipboard",
    desc: "Create a capture from the current clipboard contents.",
    bestFor: ["Fast editing", "Cross-app", "Annotation", "Asset reuse"],
    icon: Clipboard,
    tint: "warm",
    available: true,
  },
  {
    id: "scrolling-window",
    label: "Scrolling Window",
    desc: "Record while you scroll, stitched into one tall capture.",
    bestFor: ["Webpages", "Documents", "Chats", "Dashboards"],
    icon: Scroll,
    tint: "cool",
    available: true,
  },
  {
    id: "panoramic",
    label: "Panoramic",
    desc: "Clippity auto-scrolls and stitches the whole length — hands-free.",
    bestFor: ["Long pages", "Articles", "Chat logs", "Documentation"],
    icon: Frame,
    tint: "warm",
    available: true,
  },
  {
    id: "grab-text",
    label: "Grab Text",
    desc: "OCR selectable text right off the screen, no screenshot needed.",
    bestFor: ["PDFs", "Videos", "Locked UIs", "Quick copy"],
    icon: ScanText,
    tint: "cool",
    available: true,
  },
];

/** Advanced-tier custom modes — bottom of the custom panel. */
export const CUSTOM_MODES_ADVANCED: readonly ModeDef<CustomMode>[] = [
  {
    id: "color-picker",
    label: "Color Picker",
    desc: "Sample colors and auto-generate palettes or style tokens.",
    bestFor: ["UI design", "Branding", "Theme building", "Design systems"],
    icon: Pipette,
    tint: "warm",
    available: true,
  },
  {
    id: "palette-capture",
    label: "Palette Capture",
    desc: "Generate a full color palette from any region or image.",
    bestFor: ["Photography", "Branding", "Inspiration", "UI exploration"],
    icon: Palette,
    tint: "cool",
    available: true,
  },
];

/** Capture types armable in the current build. */
export const AVAILABLE_TYPES: ReadonlySet<CaptureType> = new Set(
  CAPTURE_TYPES.filter((m) => m.available).map((m) => m.id)
);

/** Custom modes armable in the current build. */
export const AVAILABLE_CUSTOM_MODES: ReadonlySet<CustomMode> = new Set(
  [...CUSTOM_MODES_STANDARD, ...CUSTOM_MODES_ADVANCED]
    .filter((m) => m.available)
    .map((m) => m.id)
);

/**
 * Which installation capability a custom mode depends on. A mode that isn't
 * listed is part of the `core` component and is always present.
 *
 * `available` above answers "does this build implement the mode?"; this
 * answers "does *this installation* include it?" — a mode can be fully built
 * and still absent because the user declined its component in the installer
 * (see `domain::provisioning`).
 */
const MODE_CAPABILITY: Partial<Record<CustomMode, keyof Capabilities>> = {
  "grab-text": "textRecognition",
};

/** Whether `mode`'s component is part of this installation. */
export function isCustomModeInstalled(
  mode: CustomMode,
  capabilities: Capabilities
): boolean {
  const needed = MODE_CAPABILITY[mode];
  return needed === undefined || capabilities[needed] === true;
}

/**
 * Whether `mode` can actually be armed: implemented by this build **and**
 * included in this installation. The single predicate the tile grid and the
 * Capture button share, so the button can't stay enabled for a tile the grid
 * has disabled.
 */
export function isCustomModeUsable(
  mode: CustomMode,
  capabilities: Capabilities
): boolean {
  return AVAILABLE_CUSTOM_MODES.has(mode) && isCustomModeInstalled(mode, capabilities);
}

/** Map an armable custom capture-mode to the overlay mode it opens.
 *  The rest are absent (their disabled tiles prevent reaching them).
 *  Note the renames: `color-picker` → `color-pick`, `palette-capture` →
 *  `palette`. */
export const CUSTOM_MODE_TO_OVERLAY: Partial<Record<CustomMode, OverlayMode>> =
  {
    object: "object",
    // Freehand is no longer a Custom tile — it (and the other freeform
    // selection methods) live under the overlay's Region method dropdown.
    "multi-area": "multi-area",
    "color-picker": "color-pick",
    "palette-capture": "palette",
    "grab-text": "grab-text",
    "scrolling-window": "scrolling",
    panoramic: "panoramic",
  };

/**
 * Which option toggles the options panel should render for the
 * current mode. Per-mode visibility matches legacy behavior:
 *
 *   color-picker / palette-capture / grab-text  → delay only
 *   clipboard                                   → preview only
 *   scrolling-window / panoramic                → preview, clipboard,
 *                                                 enhance, delay
 *   everything else                             → all five
 *
 * `enhance` follows wherever an image is produced — it is a pass over
 * captured pixels, so the modes that yield colors or text instead of a
 * bitmap (Color-Picker, Palette, Grab-Text) leave it out.
 */
export function visibleOptionKeys(
  captureType: CaptureType,
  customMode: CustomMode | null
): ReadonlySet<string> {
  if (captureType !== "custom") {
    return new Set(["preview", "clipboard", "cursor", "enhance", "delay"]);
  }
  switch (customMode) {
    case "color-picker":
    case "palette-capture":
    case "grab-text":
      return new Set(["delay"]);
    case "clipboard":
      return new Set(["preview"]);
    case "scrolling-window":
    case "panoramic":
      return new Set(["preview", "clipboard", "enhance", "delay"]);
    default:
      return new Set(["preview", "clipboard", "cursor", "enhance", "delay"]);
  }
}

/** Tooltip text for the option toggles that exist in the UI but
 *  aren't yet wired to backend behavior. Pointing at the responsible
 *  later port keeps the deferral visible. */
export const OPTION_UNAVAILABLE_HINT: Record<string, string | undefined> = {
  preview: undefined, // wired — opens the new capture in the editor (feature #5 landed)
  clipboard: undefined, // works in MVP
  cursor: undefined, // works in MVP — landed with the overlay port
  enhance: undefined, // wired — `domain::enhance` runs before the PNG encode
  delay: undefined, // armed with the countdown port — fires the HUD strip before capture
};
