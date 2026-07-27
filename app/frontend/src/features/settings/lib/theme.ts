/**
 * Pure helpers for the settings → resolved-theme bridge.
 *
 * `themePref` lives in user settings ("light" / "dark" / "system").
 * The Tauri windows + Mica backdrop want a *resolved* `Theme`
 * ("light" / "dark"). `resolveTheme` is the seam — given a pref +
 * the OS color-scheme preference, return what to apply.
 *
 * Unit-tested without DOM access (the OS-pref query is passed in as
 * a boolean so the helper stays pure).
 */

import type { Theme } from "@state/themeStore";
import type { ThemePref } from "../types";

export function resolveTheme(pref: ThemePref, osPrefersDark: boolean): Theme {
  if (pref === "system") return osPrefersDark ? "dark" : "light";
  return pref;
}

/**
 * Inverse — when the user clicks the dashboard's Light / Dark
 * footer button (which writes to `themeStore` for snappy local
 * feedback), figure out what `ThemePref` to persist. If the user
 * clicked the theme they already had via System, we leave the pref
 * on "system"; only an explicit dissent flips it to "light"/"dark".
 */
export function inferPrefFromExplicit(
  currentPref: ThemePref,
  next: Theme,
  osPrefersDark: boolean
): ThemePref {
  if (currentPref === "system") {
    // The user explicitly picked the OPPOSITE of what System resolves
    // to → flip to an explicit pref. Picking the same as System keeps
    // pref on System.
    const systemResolved: Theme = osPrefersDark ? "dark" : "light";
    return next === systemResolved ? "system" : next;
  }
  return next;
}

/**
 * Foreground ("ink") to place on a *solid accent fill* (primary CTAs,
 * the overlay capture button, selection badges, …).
 *
 * The accent is user-customizable — any hex, plus the light brand
 * presets (Teal / Lavender / Gold / Mint) — so a hardcoded `white`
 * foreground goes unreadable the moment a light accent is chosen. We
 * pick white or a dark slate from the accent's WCAG relative luminance
 * and mirror the result into `--color-accent-ink` (see `Providers.tsx`).
 *
 * Threshold: the contrast-maximizing crossover sits near L≈0.26, but the
 * brand's default Coral (L≈0.33) has always shipped with white text. To
 * preserve that identity we only flip to dark ink for *clearly* light
 * accents (L > 0.45): Coral/Slate keep white, while Mint/Gold/Teal/
 * Lavender (and any light custom hex) get dark ink.
 *
 * Pure (no DOM) so it unit-tests like `resolveTheme`.
 */
export const ACCENT_INK_LIGHT = "#ffffff";
export const ACCENT_INK_DARK = "#23272e";
const ACCENT_INK_LUMINANCE_CUTOFF = 0.45;

export function accentInk(accentHex: string): string {
  const lum = relativeLuminance(accentHex);
  // Unparseable accent → white, matching the pre-token default so we
  // never regress a valid accent into low contrast on a parse miss.
  if (lum === null) return ACCENT_INK_LIGHT;
  return lum > ACCENT_INK_LUMINANCE_CUTOFF ? ACCENT_INK_DARK : ACCENT_INK_LIGHT;
}

/** WCAG relative luminance (0..1) for a `#RRGGBB` string, or null if it
 *  isn't a 6-digit hex (the app normalizes accents to this form). */
function relativeLuminance(hex: string): number | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const int = parseInt(m[1]!, 16);
  const channels = [(int >>> 16) & 255, (int >>> 8) & 255, int & 255];
  const [r, g, b] = channels.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
