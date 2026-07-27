/**
 * 2px accent bar pinned to the bottom of the toast that drains as the
 * auto-dismiss timer counts down. Driven by `useAutoDismiss`'s
 * `progress` (1 = full, 0 = expired).
 *
 * Hidden for sticky toasts (`progress` stays at 1, parent gates the
 * render).
 */
export function ProgressBar({ progress }: { progress: number }) {
  return (
    <span
      aria-hidden
      className="absolute bottom-0 left-0 h-[2px] bg-[var(--color-accent)] transition-[width] duration-100 ease-linear"
      style={{ width: `${Math.round(progress * 100)}%` }}
    />
  );
}
