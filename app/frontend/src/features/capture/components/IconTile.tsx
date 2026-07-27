import { cn } from "@shared/lib/cn";

import type { ModeIcon, ModeTint } from "../types";

interface IconTileProps {
  icon: ModeIcon;
  tint: ModeTint;
}

/**
 * Small color-coded icon chip used by mode tiles and option rows.
 * Warm tint follows the user's accent (`--color-tile-warm/-ink`),
 * cool tint stays in the brand teal family — both auto-flip for the
 * dark theme via theme.css.
 */
export function IconTile({ icon: Icon, tint }: IconTileProps) {
  return (
    <span
      className={cn(
        "grid h-9 w-9 shrink-0 place-items-center rounded-[12px]",
        tint === "warm"
          ? "bg-[var(--color-tile-warm)] text-[var(--color-tile-warm-ink)]"
          : "bg-[var(--color-tile-cool)] text-[var(--color-tile-cool-ink)]"
      )}
    >
      <Icon size={17} strokeWidth={1.9} />
    </span>
  );
}
