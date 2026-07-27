import type { ReactNode } from "react";

import { cn } from "@shared/lib/cn";

interface WindowFrameProps {
  /** Inner padding gutter around the content canvas. */
  padding?: "none" | "sm" | "md" | "lg";
  /** Hides the rounded outer shell — for HUDs that overlay the desktop. */
  borderless?: boolean;
  className?: string;
  children: ReactNode;
}

const PADDING_CLASS: Record<
  NonNullable<WindowFrameProps["padding"]>,
  string
> = {
  none: "",
  sm: "p-2",
  md: "p-3",
  lg: "p-5",
};

/**
 * The chrome wrapper every Tauri window mounts inside. Tauri windows
 * are configured transparent + decorations-false; on Windows 11 DWM
 * natively rounds the OS frame (see
 * `platform::windows::chrome::round_window_corners`) and Mica fills
 * the translucent area, so this component just supplies the canvas
 * tint + padding and lets DWM own the rounded boundary. Adding a
 * second CSS-rounded shell here would produce a visible "frame inside
 * a frame" — two rounded shapes at slightly different radii with a
 * Mica halo between them.
 *
 * Window dragging is opt-in, not window-wide: the only draggable surface is
 * the `TitleBar` (which carries its own `data-tauri-drag-region` + `.drag-region`,
 * and whose buttons opt out with `.no-drag`). This frame is intentionally NOT a
 * drag region, so click-and-drag gestures on content (e.g. the editor canvas)
 * are never stolen as window moves. `borderless` skips the `app-canvas-bg` tint
 * entirely — used by HUDs (countdown, future overlay chrome) that overlay the
 * desktop with no shell.
 */
export function WindowFrame({
  padding = "md",
  borderless = false,
  className,
  children,
}: WindowFrameProps) {
  return (
    <div
      className={cn(
        "h-full w-full overflow-hidden",
        !borderless && "app-canvas-bg",
        PADDING_CLASS[padding],
        className
      )}
    >
      {children}
    </div>
  );
}
