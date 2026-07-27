import { useEffect, type ReactNode } from "react";
import { MotionConfig } from "motion/react";

import { useThemeStore } from "@state/themeStore";

interface ProvidersProps {
  children: ReactNode;
}

/**
 * App-wide providers: keeps `<html data-theme>` in sync with the theme
 * store and wires the reduced-motion preference into MotionConfig.
 *
 * The wizard is dark-first (every design board is dark), so the store is
 * pinned to dark on mount; the light token set still resolves if that is
 * ever relaxed.
 */
export function Providers({ children }: ProvidersProps) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const reduceMotion = useThemeStore((s) => s.reduceMotion);

  // Dark-first: match the design boards on first paint.
  useEffect(() => {
    setTheme("dark");
  }, [setTheme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      {children}
    </MotionConfig>
  );
}
