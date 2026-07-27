import type { ReactNode } from "react";

import { cn } from "@shared/lib/cn";

interface WindowFrameProps {
  padding?: "none" | "sm" | "md" | "lg";
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
 * The chrome wrapper the wizard mounts inside. The Tauri window is
 * transparent + decorations-false; on Windows 11 DWM natively rounds the
 * OS frame, so this component just supplies the canvas tint + padding.
 * The `.drag-region` opt-in lives on the `TitleBar`, not here, so drags
 * on content are never stolen as window moves.
 */
export function WindowFrame({
  padding = "none",
  className,
  children,
}: WindowFrameProps) {
  return (
    <div
      className={cn(
        "app-canvas-bg h-full w-full overflow-hidden",
        PADDING_CLASS[padding],
        className
      )}
    >
      {children}
    </div>
  );
}
