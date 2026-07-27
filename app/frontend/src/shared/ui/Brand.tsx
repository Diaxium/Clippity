import { useThemeStore } from "@state/themeStore";
import { cn } from "@shared/lib/cn";

import appLight from "@assets/logos/App-light.png";
import appDark from "@assets/logos/App-dark.png";
import monoLight from "@assets/logos/Monochrome-light.png";
import monoDark from "@assets/logos/Monochrome-dark.png";

interface BrandProps {
  /** "app" = full-colour mark, "mono" = monochrome mark. Omit to follow
   *  the user's App-icon appearance preference (`appearance.appIcon`,
   *  mirrored into the theme store). */
  variant?: "app" | "mono";
  /** Mark size in px (square). */
  size?: number;
  /** Show the "Clippity" wordmark next to the mark. */
  showWordmark?: boolean;
  className?: string;
}

/**
 * App logo + wordmark cluster. Reads the current theme from the global
 * store so the mark auto-switches between light/dark variants without
 * the caller having to thread it through. When `variant` is omitted it
 * also follows the user's App-icon style preference (Colour → the
 * full-colour mark, Monochrome → the mono glyph), so the TitleBar mark
 * tracks Settings → Appearance → App icon automatically.
 *
 * Used by `TitleBar` (with wordmark) and the Settings → Appearance
 * preview (explicit `variant`, no wordmark).
 */
export function Brand({
  variant,
  size = 22,
  showWordmark = true,
  className,
}: BrandProps) {
  const theme = useThemeStore((s) => s.theme);
  const appIcon = useThemeStore((s) => s.appIcon);
  const dark = theme === "dark";
  // Explicit prop wins (the Appearance preview forces each style); with
  // no prop, follow the persisted App-icon preference.
  const resolvedVariant: "app" | "mono" =
    variant ?? (appIcon === "monochrome" ? "mono" : "app");
  const src =
    resolvedVariant === "mono"
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
          Clippity
        </span>
      )}
    </span>
  );
}
