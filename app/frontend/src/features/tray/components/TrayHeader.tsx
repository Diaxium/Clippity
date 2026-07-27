import { Settings, X } from "lucide-react";

import { Brand } from "@shared/ui";

interface TrayHeaderProps {
  onSettings: () => void;
  onClose: () => void;
}

const ICON_BTN =
  "focus-ring no-drag grid h-7 w-7 place-items-center rounded-lg text-[var(--color-hint)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]";

/**
 * Panel header: the Clippity wordmark on the left, Settings + Close icon
 * buttons on the right. Close hides the flyout — it does NOT quit (Quit
 * lives in the footer).
 */
export function TrayHeader({ onSettings, onClose }: TrayHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <Brand size={20} />
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label="Open settings"
          title="Settings"
          onClick={onSettings}
          className={ICON_BTN}
        >
          <Settings size={15} strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className={ICON_BTN}
        >
          <X size={15} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
