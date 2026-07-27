import { AppWindow, Crop, Maximize, type LucideIcon } from "lucide-react";

/**
 * Display metadata (label + icon) for the capture types a preset can
 * target. Shared by the presets manager (`features/presets`) and the
 * tray's Presets section (`features/tray`) so a preset reads the same in
 * both — `custom` is intentionally absent (not a valid preset target).
 */
export interface CaptureTypeMeta {
  label: string;
  icon: LucideIcon;
}

export type PresetCaptureType = "fullscreen" | "region" | "window";

export const CAPTURE_TYPE_META: Record<PresetCaptureType, CaptureTypeMeta> = {
  fullscreen: { label: "Fullscreen", icon: Maximize },
  region: { label: "Region", icon: Crop },
  window: { label: "Window", icon: AppWindow },
};

/** Resolve metadata for any capture type, defaulting to Fullscreen for
 *  the `custom` case (never a preset target, but keeps callers total). */
export function captureTypeMeta(type: string): CaptureTypeMeta {
  return (
    CAPTURE_TYPE_META[type as PresetCaptureType] ?? CAPTURE_TYPE_META.fullscreen
  );
}
