import { History } from "lucide-react";

interface RepeatLastRegionProps {
  onClick: () => void;
}

/**
 * "Same region as last time" — a one-shot repeat of the previous
 * rectangular selection, with no overlay in between.
 *
 * A slim full-width row rather than a fifth capture tile: the four tiles
 * are the capture *types*, and this is a shortcut through one of them,
 * not a peer. It also has no useful disabled state to render — whether a
 * region is remembered lives in the backend, and asking for it on every
 * tray open would cost an IPC round trip to grey out a button. The
 * backend rejects with a readable message instead (nothing remembered
 * yet, or the display layout changed), which the panel surfaces as an
 * error toast.
 */
export function RepeatLastRegion({ onClick }: RepeatLastRegionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Capture the same area as your last region capture"
      className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-[color:var(--hairline)] px-2 py-1.5 text-[11.5px] font-medium text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
    >
      <History size={13} strokeWidth={1.85} />
      <span>Repeat last region</span>
    </button>
  );
}
