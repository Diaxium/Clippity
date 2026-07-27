import { Minus, X } from "lucide-react";
import { motion } from "motion/react";

import { cn } from "@shared/lib/cn";
import { closeWindow, minimizeWindow } from "@services/tauri";

import { Brand } from "./Brand";

interface TitleBarProps {
  className?: string;
}

/**
 * Custom title bar for the wizard's borderless Tauri window.
 *
 * The whole bar is the drag region; the window controls opt out via
 * `.no-drag`. Controls route through the Tauri bridge, which no-ops in
 * browser preview. A setup wizard isn't maximizable, so only Minimize +
 * Close are offered.
 */
export function TitleBar({ className }: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className={cn(
        "drag-region flex h-11 shrink-0 items-center gap-2 px-3",
        className
      )}
    >
      <span className="no-drag flex items-center">
        <Brand size={20} wordmark="Clippity Setup" />
      </span>

      <span className="flex-1" data-tauri-drag-region />

      <motion.button
        type="button"
        whileTap={{ scale: 0.9 }}
        onClick={() => void minimizeWindow()}
        aria-label="Minimize"
        className="no-drag focus-ring grid h-8 w-8 place-items-center rounded-md text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      >
        <Minus size={15} strokeWidth={1.85} />
      </motion.button>
      <motion.button
        type="button"
        whileTap={{ scale: 0.9 }}
        onClick={() => void closeWindow()}
        aria-label="Close"
        className="no-drag focus-ring grid h-8 w-8 place-items-center rounded-md text-[var(--color-slate)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-ink)]"
      >
        <X size={15} strokeWidth={1.85} />
      </motion.button>
    </header>
  );
}
