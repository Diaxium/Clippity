import { Sparkles } from "lucide-react";

import type { CaptureNav } from "../types";

interface ComingSoonProps {
  section: CaptureNav;
}

/**
 * Placeholder card for the capture-window's nav sections that aren't
 * implemented yet (Record, History, Presets). Mirrors the legacy
 * placeholder so the empty state has visual weight.
 */
export function ComingSoon({ section }: ComingSoonProps) {
  const label = section[0]?.toUpperCase() + section.slice(1);
  return (
    <div className="grid flex-1 place-items-center p-10">
      <div className="flex flex-col items-center gap-2 rounded-[16px] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-12 py-14 text-center shadow-[var(--shadow-medium)]">
        <Sparkles
          size={26}
          strokeWidth={1.75}
          className="text-[var(--color-hint)]"
        />
        <h2 className="text-base font-semibold text-[var(--color-ink)]">
          {label}
        </h2>
        <p className="text-[13px] text-[var(--color-slate)]">
          This section is coming soon.
        </p>
      </div>
    </div>
  );
}
