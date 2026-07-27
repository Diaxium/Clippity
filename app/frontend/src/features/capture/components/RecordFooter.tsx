import { motion } from "motion/react";

import { cn } from "@shared/lib/cn";

import { useCaptureStore } from "../state/captureStore";
import { recordReadiness } from "../recordModes";

interface RecordFooterProps {
  onRecord: () => void;
  compact?: boolean;
}

/**
 * Bottom action bar for the Record screen — the counterpart to
 * `CaptureFooter`, down to the Space hint, so the two screens have the
 * same muscle memory.
 *
 * The glyph is a filled dot rather than the capture ring: it is the
 * universal record affordance, and it is what the HUD's Stop square
 * pairs with.
 */
export function RecordFooter({ onRecord, compact = false }: RecordFooterProps) {
  const target = useCaptureStore((s) => s.recordTarget);
  const format = useCaptureStore((s) => s.recordFormat);
  const { ready, reason } = recordReadiness(target, format);

  return (
    <footer
      className={cn(
        "app-canvas-bg relative z-10 flex items-center justify-end gap-3 shadow-[var(--shadow-medium)]",
        compact ? "px-4 py-2" : "px-5 py-3"
      )}
    >
      <motion.button
        type="button"
        onClick={onRecord}
        disabled={!ready}
        title={reason}
        whileHover={ready ? { y: -1 } : undefined}
        whileTap={ready ? { scale: 0.985 } : undefined}
        transition={{ duration: 0.16, ease: [0.4, 0, 0.2, 1] }}
        className={cn(
          "focus-ring group flex h-[44px] w-[176px] items-center justify-between rounded-[12px] border border-[color:var(--hairline-strong)] bg-[var(--color-surface)] px-3.5 text-[var(--color-ink)] shadow-[var(--shadow-medium)] transition-shadow",
          ready
            ? "hover:shadow-[0_10px_26px_rgba(17,24,39,0.10)]"
            : "cursor-not-allowed opacity-55"
        )}
      >
        <span className="flex items-center gap-2.5">
          <span
            className="grid h-[18px] w-[18px] place-items-center rounded-full border-[1.5px] border-[var(--color-accent)]"
            aria-hidden
          >
            <span className="h-[9px] w-[9px] rounded-full bg-[var(--color-accent)]" />
          </span>
          <span className="text-[13px] font-semibold">
            {format === "gif" ? "Record GIF" : "Record"}
          </span>
        </span>
        <kbd className="rounded-md bg-[color:var(--color-overlay-2)] px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-[var(--color-hint)]">
          Space
        </kbd>
      </motion.button>
    </footer>
  );
}
