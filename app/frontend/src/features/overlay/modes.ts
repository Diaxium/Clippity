/**
 * Per-mode + per-phase banner copy + R/W/F/C sidebar metadata.
 *
 * The legacy version inlined an ~80-line per-mode string switch in
 * the render path; this is the same data as a tiny strategy table
 * keyed by `(mode, phase)`. Only Region populates real strings for
 * MVP — other modes return their "deferred" copy so the wire shape
 * doesn't break when those ports land.
 */

import type { ComponentType } from "react";

import {
  AppWindow,
  Brush,
  Crop,
  Lasso,
  Magnet,
  Maximize,
  PenTool,
  Square,
  SquarePen,
} from "lucide-react";

import type { BannerCopy, OverlayMode, Phase } from "./types";

type IconComponent = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
}>;
type Tint = "warm" | "cool";

/** Region-mode banner copy — primary string changes with phase so
 *  the user always sees a next-step prompt. */
const REGION_BY_PHASE: Record<Phase, BannerCopy> = {
  empty: {
    primary: "Select an area to capture",
    shortcut: "ESC to cancel",
  },
  idle: {
    primary: "Move the crosshair to choose where to start",
    shortcut: "ESC to cancel",
  },
  dragging: {
    primary: "Drag to select the area you want to capture",
    shortcut: "ESC to cancel",
  },
  selected: {
    primary: "Drag handles to adjust · Press Capture or Enter",
    shortcut: "ESC to cancel",
  },
};

/** Resolve the banner copy for the current (mode, phase). Window mode
 *  has no drag phases, so it shows one steady prompt; modes beyond
 *  Region + Window are placeholders awaiting their respective ports. */
export function bannerCopy(mode: OverlayMode, phase: Phase): BannerCopy {
  if (mode === "region") return REGION_BY_PHASE[phase];
  if (mode === "window") {
    return {
      primary: "Hover a window to highlight it · Click to capture",
      shortcut: "ESC to cancel",
    };
  }
  // The recording modes reuse Region's and Window's interactions but say
  // "record", not "capture" — the commit starts a session that keeps
  // running, which is a different promise from taking a shot.
  if (mode === "record-region") {
    return {
      primary:
        phase === "selected"
          ? "Drag handles to adjust · Press Record or Enter"
          : "Drag to select the area you want to record",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "record-window") {
    return {
      primary: "Hover a window to highlight it · Click to record it",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "object") {
    return {
      primary: "Hover a detected element · Click to capture it",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "freehand") {
    return {
      primary:
        phase === "selected"
          ? "Press Capture or Enter · drag again to redraw"
          : "Draw a freeform shape around what you want",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "pen") {
    return {
      primary:
        phase === "selected"
          ? "Press Capture or Enter · drag a handle to adjust"
          : "Click to add anchor points · drag for curves · Enter to close",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "magnetic-lasso") {
    return {
      primary:
        phase === "selected"
          ? "Press Capture or Enter · drag again to retrace"
          : "Drag to trace — Clippity snaps to the nearest edges",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "brush") {
    return {
      primary:
        phase === "selected"
          ? "Press Capture or Enter · paint to add, Alt to subtract"
          : "Paint over the area you want to capture",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "multi-area") {
    return {
      primary:
        "Drag to add areas · Backspace removes the last · Enter captures",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "color-pick") {
    return {
      primary: "Click any pixel to copy its color",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "palette") {
    return {
      primary:
        phase === "selected"
          ? "Press Capture or Enter to extract the palette"
          : "Drag a region to extract its color palette",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "grab-text") {
    return {
      primary:
        phase === "selected"
          ? "Press Grab Text or Enter to read it"
          : "Drag over the text you want Clippity to read",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "scrolling") {
    return {
      primary:
        phase === "selected"
          ? "Press Record or Enter, then scroll the content"
          : "Select the scrollable area you want to record",
      shortcut: "ESC to cancel",
    };
  }
  if (mode === "panoramic") {
    return {
      primary:
        phase === "selected"
          ? "Press Start or Enter — Clippity scrolls and captures for you"
          : "Select the scrollable area to auto-capture",
      shortcut: "ESC to cancel",
    };
  }
  return { primary: "This mode is not available yet." };
}

// ---- Capture-type sidebar (R / W / F / C) -------------------------

interface SidebarItem {
  id: "region" | "window" | "fullscreen" | "custom";
  label: string;
  shortcut: "R" | "W" | "F" | "C";
  icon: IconComponent;
  tint: Tint;
  /** False = visibly disabled. Region + Window + Fullscreen reach this
   *  port; C unblocks with the custom-modes port. */
  enabled: boolean;
}

// ---- Region selection methods (the Region dropdown) ----------------

/** An area-selection method offered under the unified Region control.
 *  Every method crops the same desktop snapshot to a drawn shape; they
 *  differ only in how the user draws it. */
export interface RegionMethod {
  id: Extract<
    OverlayMode,
    "region" | "freehand" | "pen" | "magnetic-lasso" | "brush"
  >;
  label: string;
  icon: IconComponent;
  /** One-line affordance shown in the dropdown row. */
  hint: string;
  /** False = listed but disabled (e.g. Brush before its backend lands). */
  available: boolean;
}

/** The Region method menu, in display order. Rectangle is the default
 *  (the overlay always opens here); the rest swap in place via
 *  `setOverlayMode` without re-snapshotting. */
export const REGION_METHODS: readonly RegionMethod[] = [
  {
    id: "region",
    label: "Rectangle",
    icon: Square,
    hint: "Drag out a box",
    available: true,
  },
  {
    id: "freehand",
    label: "Freehand",
    icon: Lasso,
    hint: "Draw any freeform shape",
    available: true,
  },
  {
    id: "pen",
    label: "Pen / Bézier",
    icon: PenTool,
    hint: "Anchor points + curves",
    available: true,
  },
  {
    id: "magnetic-lasso",
    label: "Magnetic Lasso",
    icon: Magnet,
    hint: "Trace — snaps to edges",
    available: true,
  },
  {
    id: "brush",
    label: "Brush",
    icon: Brush,
    hint: "Paint the area",
    available: true,
  },
];

/** Whether `mode` is one of the Region-family selection methods (drives
 *  the bottom toolbar's method dropdown visibility). */
export function isRegionMethod(mode: OverlayMode): boolean {
  return REGION_METHODS.some((m) => m.id === mode);
}

export const SIDEBAR_ITEMS: readonly SidebarItem[] = [
  {
    id: "region",
    label: "Region",
    shortcut: "R",
    icon: Crop,
    tint: "warm",
    enabled: true,
  },
  {
    id: "window",
    label: "Window",
    shortcut: "W",
    icon: AppWindow,
    tint: "cool",
    enabled: true,
  },
  {
    id: "fullscreen",
    label: "Fullscreen",
    shortcut: "F",
    icon: Maximize,
    tint: "warm",
    enabled: true,
  },
  {
    id: "custom",
    label: "Custom",
    shortcut: "C",
    icon: SquarePen,
    tint: "cool",
    enabled: false,
  },
];
