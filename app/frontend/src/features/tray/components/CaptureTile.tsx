import { forwardRef } from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@shared/lib/cn";

export type TileTint = "primary" | "warm" | "cool";

interface CaptureTileProps {
  icon: LucideIcon;
  label: string;
  /** Native title + accessible label describing the action. */
  hint: string;
  tint: TileTint;
  onClick: () => void;
}

const CHIP_CLASS: Record<TileTint, string> = {
  primary: "bg-[var(--color-accent)] text-[var(--color-accent-ink)]",
  warm: "bg-[var(--color-tile-warm)] text-[var(--color-tile-warm-ink)]",
  cool: "bg-[var(--color-tile-cool)] text-[var(--color-tile-cool-ink)]",
};

/**
 * One capture-mode action in the tray panel: a compact tile with a tinted
 * icon chip above a single-line label, in a card that lifts on hover. The
 * fixed height + truncating label keep all four tiles in the row uniform
 * regardless of label length. `forwardRef` so the panel can focus the
 * first tile when the flyout opens.
 */
export const CaptureTile = forwardRef<HTMLButtonElement, CaptureTileProps>(
  function CaptureTile({ icon: Icon, label, hint, tint, onClick }, ref) {
    return (
      <motion.button
        ref={ref}
        type="button"
        onClick={onClick}
        title={hint}
        aria-label={hint}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.97 }}
        transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
        className={cn(
          "focus-ring no-drag flex h-[58px] flex-col items-center justify-center gap-1 rounded-[11px] border px-1 transition-shadow",
          "border-[color:var(--hairline)] bg-[var(--color-surface)] hover:shadow-[var(--shadow-medium)]"
        )}
      >
        <span
          className={cn(
            "grid h-8 w-8 place-items-center rounded-[9px]",
            CHIP_CLASS[tint]
          )}
        >
          <Icon size={16} strokeWidth={1.9} />
        </span>
        <span className="w-full truncate text-center text-[10px] font-medium leading-none text-[var(--color-ink)]">
          {label}
        </span>
      </motion.button>
    );
  }
);
