import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { useOverlayStore } from "../state/overlayStore";

/**
 * Centered "Drag to select" placeholder shown only in the `empty`
 * phase. Disappears on first pointer-move (which transitions to
 * `idle`). Region mode only — other modes have their own affordances.
 */
export function EmptyHint() {
  const phase = useOverlayStore((s) => s.phase);
  const mode = useOverlayStore((s) => s.mode);

  return (
    <AnimatePresence>
      {phase === "empty" && mode === "region" && (
        <motion.div
          key="hint"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        >
          <div className="flex h-[420px] w-[760px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/30 text-white/70">
            <div className="grid h-12 w-12 place-items-center rounded-xl border-2 border-dashed border-white/35 text-white/65">
              <Plus size={20} strokeWidth={2} />
            </div>
            <p className="mt-3 text-center text-[15px] font-medium leading-snug text-white/85">
              Drag to select the area
              <br />
              you want to capture
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
