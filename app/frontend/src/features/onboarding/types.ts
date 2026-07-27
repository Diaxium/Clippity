/**
 * Onboarding feature — local types.
 *
 * The wizard reads/writes through the `Settings` wire types
 * (`GeneralSettings`, `AppearanceSettings`) — no new IPC shape. Only
 * the step-index union and a tiny preset row type live here.
 */

export const STEP_IDS = ["storage", "theme", "accent"] as const;

export type StepId = (typeof STEP_IDS)[number];

/** Zero-based step cursor used by the wizard's controller hook. */
export type StepIndex = 0 | 1 | 2;
