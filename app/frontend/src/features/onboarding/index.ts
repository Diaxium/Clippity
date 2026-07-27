/**
 * Onboarding feature — public surface.
 *
 * Only `OnboardingLayout` is exported. `AppShell` mounts it gated on
 * `settings.general.onboarded === false` for the user-facing windows
 * (capture / main). System routes (overlay / countdown / toast) bypass
 * the gate — those windows are transient utilities that fire AFTER the
 * wizard has run.
 */

export { OnboardingLayout } from "./components/OnboardingLayout";
