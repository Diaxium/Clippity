import { motion } from "motion/react";

import { cn } from "@shared/lib/cn";

import { useCapabilities } from "@state/useCapabilities";

import { useCaptureStore } from "../state/captureStore";
import { AVAILABLE_TYPES, isCustomModeUsable } from "../modes";

interface CaptureFooterProps {
  onCapture: () => void;
  compact?: boolean;
}

/**
 * Bottom action bar: the primary Capture trigger, right-aligned. (The
 * cross-window jump to the dashboard now lives in the sidebar's
 * ThemeToggle pill, so this bar holds only the capture action.) The
 * button is disabled when the user's current mode isn't shippable yet
 * (e.g. region before overlay lands).
 */
export function CaptureFooter({
  onCapture,
  compact = false,
}: CaptureFooterProps) {
  const captureType = useCaptureStore((s) => s.captureType);
  const customMode = useCaptureStore((s) => s.customMode);
  const capabilities = useCapabilities();

  const ready =
    captureType !== "custom"
      ? AVAILABLE_TYPES.has(captureType)
      : customMode !== null && isCustomModeUsable(customMode, capabilities);

  const disabledTitle = ready
    ? undefined
    : captureType === "custom"
      ? "Pick an available custom mode to enable Capture"
      : "This capture mode isn't available yet — see the tooltip on its tile";

  return (
    <footer
      className={cn(
        "app-canvas-bg relative z-10 flex items-center justify-end gap-3 shadow-[var(--shadow-medium)]",
        compact ? "px-4 py-2" : "px-5 py-3"
      )}
    >
      <motion.button
        type="button"
        onClick={onCapture}
        disabled={!ready}
        title={disabledTitle}
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
            className="capture-ring grid h-[18px] w-[18px] place-items-center rounded-full border-[1.5px] border-[var(--color-accent)]"
            aria-hidden
          >
            <span className="h-[7px] w-[7px] rounded-full bg-[var(--color-accent)]" />
          </span>
          <span className="text-[13px] font-semibold">Capture</span>
        </span>
        <kbd className="rounded-md bg-[color:var(--color-overlay-2)] px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-[var(--color-hint)]">
          Space
        </kbd>
      </motion.button>
    </footer>
  );
}
