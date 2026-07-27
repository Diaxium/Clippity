import { HelpCircle, SquareDashed } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { CHROME_STOP_PROPS } from "../eventStops";
import { useOverlayStore } from "../state/overlayStore";
import { bannerCopy } from "../modes";

/**
 * State-aware instruction banner pinned to the top of the overlay.
 * Only visible in `empty` and `idle` phases (progressive disclosure) —
 * the toolbar provides sufficient context once a selection exists.
 * Animates in/out with a small vertical slide so phase transitions feel
 * intentional rather than abrupt.
 */
export function TopBanner() {
  const mode = useOverlayStore((s) => s.mode);
  const phase = useOverlayStore((s) => s.phase);
  const helpOpen = useOverlayStore((s) => s.helpOpen);
  const setHelpOpen = useOverlayStore((s) => s.setHelpOpen);

  const copy = bannerCopy(mode, phase);
  const visible = phase === "empty" || phase === "idle";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="top-banner"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="pointer-events-none absolute left-1/2 top-7 -translate-x-1/2"
        >
          <div
            {...CHROME_STOP_PROPS}
            className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-[color:var(--hairline)] bg-[var(--color-surface)] px-4 py-2.5 text-[13px] font-medium text-[var(--color-ink)] shadow-[var(--shadow-elevated)] backdrop-blur-md"
          >
            <SquareDashed
              size={16}
              strokeWidth={1.75}
              className="text-[var(--color-slate)]"
            />
            <span>{copy.primary}</span>
            {copy.shortcut && (
              <>
                <span className="ml-1 inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-overlay-2)] px-1.5 py-1 text-[11px] font-semibold tracking-wide text-[var(--color-slate)]">
                  ESC
                </span>
                <span className="text-[11px] text-[var(--color-hint)]">
                  to cancel
                </span>
              </>
            )}
            <span aria-hidden className="h-4 w-px bg-[color:var(--hairline)]" />
            <button
              type="button"
              onClick={() => setHelpOpen(!helpOpen)}
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              className="focus-ring inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
            >
              <HelpCircle size={13} strokeWidth={2} />
              <span className="font-mono">?</span>
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
