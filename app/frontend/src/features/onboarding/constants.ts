/**
 * Onboarding — static tables (steps, labels). The accent / theme
 * tables are intentionally NOT duplicated here: the wizard reads them
 * from `features/settings/constants.ts` (`ACCENT_PRESETS`) and from
 * the same `ThemePref` union the settings panel uses, so flipping a
 * preset in one place updates both.
 */

import type { StepId } from "./types";

export interface StepDef {
  id: StepId;
  label: string;
}

/** Display order matches the legacy wizard. */
export const STEPS: readonly StepDef[] = [
  { id: "storage", label: "Storage" },
  { id: "theme", label: "Theme" },
  { id: "accent", label: "Accent" },
] as const;
