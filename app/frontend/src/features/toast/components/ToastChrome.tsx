import { Focus, X } from "lucide-react";

import { showCaptureWindow } from "@services/tauri/clients/toast";

interface ToastChromeProps {
  /** Called after the user clicks Focus — gives the parent a chance
   *  to dismiss before the capture window shows. */
  onFocus: () => void;
  /** Called when the user clicks the × button. */
  onDismiss: () => void;
}

/**
 * Top-right chrome cluster — Focus + Dismiss buttons present on every
 * toast variant. The Focus button is the "open the capture window"
 * affordance from the legacy; Dismiss starts the exit animation.
 *
 * Lives outside `<body>` so the per-variant body component doesn't
 * have to think about chrome — it just renders its message.
 */
export function ToastChrome({ onFocus, onDismiss }: ToastChromeProps) {
  return (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Open capture window"
        title="Open capture window"
        onClick={() => {
          onFocus();
          void showCaptureWindow();
        }}
        className="focus-ring grid h-7 w-7 place-items-center rounded-lg text-[var(--color-hint)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
      >
        <Focus size={13} strokeWidth={2.2} />
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="focus-ring grid h-7 w-7 place-items-center rounded-lg text-[var(--color-hint)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
      >
        <X size={13} strokeWidth={2.2} />
      </button>
    </div>
  );
}
