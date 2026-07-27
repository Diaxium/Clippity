import { AnimatePresence, motion } from "motion/react";

interface CountdownNumberProps {
  value: number;
}

/**
 * Right-aligned countdown numeral — the #1 element in the spec's
 * visual hierarchy: large (spec: 48–72 px), bold, and unadorned. No
 * ring / badge / dot / container — "the number alone is enough." Each
 * whole-second change swaps the numeral with a subtle scale + fade so
 * the tick reads as a soft beat, never a bounce or spin. `MotionConfig`
 * (set in AppShell) drops the transition under reduced-motion
 * automatically, leaving a clean static swap.
 *
 * The box is fixed-size with `text-right` + `overflow-visible` so a
 * two-digit value (the timer accepts up to 60 s) right-anchors and
 * spills leftward instead of clipping or shifting the right edge.
 */
export function CountdownNumber({ value }: CountdownNumberProps) {
  return (
    <span className="relative block h-[64px] w-[64px] overflow-visible text-right">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ scale: 1.12, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.86, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
          className="absolute inset-0 text-[60px] font-semibold leading-none text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.55)]"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
