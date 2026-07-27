import { cn } from "@shared/lib/cn";
import type { IconComponent } from "@shared/lib/icon";

type TileTint = "accent" | "violet" | "gold" | "neutral";

const TINT_CLASS: Record<TileTint, string> = {
  accent:
    "bg-[var(--color-tile-warm)] text-[var(--color-tile-warm-ink)]",
  violet:
    "bg-[var(--color-tile-violet)] text-[var(--color-tile-violet-ink)]",
  gold: "bg-[var(--color-tile-gold)] text-[var(--color-tile-gold-ink)]",
  neutral: "bg-[var(--color-overlay-2)] text-[var(--color-slate)]",
};

interface IconTileProps {
  icon: IconComponent;
  tint?: TileTint;
  size?: number;
  className?: string;
}

/**
 * A soft rounded tile holding a single icon — the same pattern the app's
 * dashboard uses. Drives the maintenance-hub action cards and the
 * component/data-row leading glyphs.
 */
export function IconTile({
  icon: Icon,
  tint = "accent",
  size = 40,
  className,
}: IconTileProps) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-[var(--radius-md)]",
        TINT_CLASS[tint],
        className
      )}
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.45)} strokeWidth={1.8} />
    </span>
  );
}
