import { motion } from "motion/react";

interface ProgressBarProps {
  /** 0..100. */
  percent: number;
}

/**
 * The accent-filled determinate bar shown on the Installing / Applying /
 * Uninstalling steps. The fill animates to each new width.
 */
export function ProgressBar({ percent }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-overlay-2)]">
      <motion.div
        className="h-full rounded-full bg-[var(--color-accent)]"
        initial={false}
        animate={{ width: `${clamped}%` }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        style={{
          boxShadow: "0 0 10px color-mix(in srgb, var(--color-accent) 45%, transparent)",
        }}
      />
    </div>
  );
}
