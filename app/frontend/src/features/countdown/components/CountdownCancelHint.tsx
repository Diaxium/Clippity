/**
 * Left-aligned cancel hint: "Press Esc to cancel" with the Esc key
 * rendered as a small keycap chip. Matches the bottom-left placement
 * in the design — the user's eye lands on the number first (right
 * side) and the dismissal affordance reads next.
 */
export function CountdownCancelHint() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--color-ink)] drop-shadow-[0_1px_2px_rgba(0,0,0,0.4)]">
      <span>Press</span>
      <kbd className="inline-flex items-center justify-center rounded-[5px] border border-white/20 bg-black/30 px-1.5 py-px font-mono text-[11px] font-semibold text-white shadow-[0_1px_2px_rgba(0,0,0,0.35)]">
        Esc
      </kbd>
      <span>to cancel</span>
    </span>
  );
}
