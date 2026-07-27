import { useThemeStore } from "@state/themeStore";
import { cn } from "@shared/lib/cn";

import appLight from "@assets/logos/App-light.png";
import appDark from "@assets/logos/App-dark.png";
import monoLight from "@assets/logos/Monochrome-light.png";
import monoDark from "@assets/logos/Monochrome-dark.png";

interface BrandProps {
  /** "app" = full-colour mark, "mono" = monochrome mark. */
  variant?: "app" | "mono";
  /** Mark size in px (square). */
  size?: number;
  /** Show the "Clippity" wordmark next to the mark. */
  showWordmark?: boolean;
  /** Wordmark text (defaults to the product name). */
  wordmark?: string;
  className?: string;
}

/**
 * App logo + wordmark cluster. Reads the current theme from the global
 * store so the mark auto-switches between light/dark variants.
 */
export function Brand({
  variant = "app",
  size = 22,
  showWordmark = true,
  wordmark = "Clippity",
  className,
}: BrandProps) {
  const theme = useThemeStore((s) => s.theme);
  const dark = theme === "dark";
  const src =
    variant === "mono"
      ? dark
        ? monoDark
        : monoLight
      : dark
        ? appDark
        : appLight;

  return (
    <span className={cn("flex items-center gap-2", className)}>
      <img
        src={src}
        width={size}
        height={size}
        alt="Clippity"
        className="rounded-[6px] object-contain"
        draggable={false}
      />
      {showWordmark && (
        <span className="text-[13px] font-bold tracking-tight text-[var(--color-ink)]">
          {wordmark}
        </span>
      )}
    </span>
  );
}
