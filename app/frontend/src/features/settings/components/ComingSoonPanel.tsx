import { Clock } from "lucide-react";

import { CATEGORIES } from "../constants";
import type { SettingsCategory } from "../types";

interface ComingSoonPanelProps {
  category: SettingsCategory;
}

export function ComingSoonPanel({ category }: ComingSoonPanelProps) {
  const meta = CATEGORIES.find((c) => c.id === category);
  return (
    <div className="grid h-full place-items-center text-center">
      <div className="flex flex-col items-center gap-3">
        <Clock
          size={32}
          strokeWidth={1.6}
          className="text-[var(--color-hint)]"
        />
        <div>
          <p className="text-[14px] font-semibold text-[var(--color-ink)]">
            {meta?.label ?? "Settings"}
          </p>
          <p className="mt-1 text-[12.5px] text-[var(--color-slate)]">
            {meta?.blockedBy
              ? `Coming soon, along with ${meta.blockedBy}.`
              : "Coming in a future release."}
          </p>
        </div>
      </div>
    </div>
  );
}
