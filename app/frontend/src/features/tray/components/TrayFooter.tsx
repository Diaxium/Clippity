import type { LucideIcon } from "lucide-react";
import { Images, Power, SquarePen } from "lucide-react";

import { cn } from "@shared/lib/cn";

interface TrayFooterProps {
  onLibrary: () => void;
  onEditor: () => void;
  onQuit: () => void;
}

interface FooterLinkProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function FooterLink({ icon: Icon, label, onClick, danger }: FooterLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring no-drag inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors",
        danger
          ? "text-[var(--color-hint)] hover:bg-[color:var(--color-accent-soft)] hover:text-[var(--color-accent)]"
          : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
      )}
    >
      <Icon size={14} strokeWidth={2} />
      {label}
    </button>
  );
}

/**
 * Footer row: Library + Editor shortcuts on the left, Quit on the right.
 * Library / Editor focus the main window on the matching dashboard view;
 * Quit ends the process — the only deliberate exit now that closing a
 * window minimizes to tray. (The primary capture entry point lives in the
 * `CaptureButton` above; the old footer Capture link was redundant.)
 */
export function TrayFooter({ onLibrary, onEditor, onQuit }: TrayFooterProps) {
  return (
    <div className="mt-auto flex items-center justify-between border-t border-[color:var(--hairline)] pt-2.5">
      <div className="flex items-center gap-0.5">
        <FooterLink icon={Images} label="Library" onClick={onLibrary} />
        <FooterLink icon={SquarePen} label="Editor" onClick={onEditor} />
      </div>
      <FooterLink icon={Power} label="Quit" onClick={onQuit} danger />
    </div>
  );
}
