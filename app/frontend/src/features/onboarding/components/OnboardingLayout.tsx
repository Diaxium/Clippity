import { AnimatePresence, motion } from "motion/react";
import { ChevronLeft, ChevronRight, Rocket } from "lucide-react";

import { Brand, WindowFrame } from "@shared/ui";
import type { Settings } from "@services/tauri/clients/settings";

import { useOnboardingDraft } from "../hooks/useOnboardingDraft";
import { AccentStep } from "./AccentStep";
import { StepDots } from "./StepDots";
import { StorageStep } from "./StorageStep";
import { ThemeStep } from "./ThemeStep";

interface OnboardingLayoutProps {
  /** Hydrated settings snapshot — guaranteed non-null by the caller. */
  settings: Settings;
  /** Called once `settings.general.onboarded` has been flipped to true. */
  onDone(): void;
}

/**
 * Root of the first-launch wizard. Mounted by `AppShell` when
 * `settings.general.onboarded === false` on the capture / main routes.
 * System routes (overlay / countdown / toast) bypass the gate — those
 * windows are transient utilities triggered AFTER onboarding has run.
 *
 * Layout: chromeless WindowFrame with a single header (Brand + welcome
 * line) and a 520-px-wide centred wizard column. AnimatePresence handles
 * the slide between steps; `motion/react` respects the reduced-motion
 * MotionConfig set by AppShell.
 */
export function OnboardingLayout({ settings, onDone }: OnboardingLayoutProps) {
  const draft = useOnboardingDraft({ settings, onComplete: onDone });

  return (
    <WindowFrame padding="none">
      <div className="flex h-full flex-col">
        <header
          data-tauri-drag-region
          className="flex h-12 shrink-0 items-center gap-2 px-4"
        >
          <Brand size={20} />
          <span className="text-[12.5px] font-semibold text-[var(--color-slate)]">
            Welcome to Clippity
          </span>
        </header>

        <div className="flex flex-1 items-center justify-center p-8">
          <div className="w-full max-w-[520px]">
            <StepDots step={draft.step} />

            <div className="relative mt-6 min-h-[260px]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={draft.step}
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -24 }}
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                >
                  {draft.step === 0 && (
                    <StorageStep
                      value={draft.capturesDir}
                      defaultHint={draft.defaultHint}
                      onBrowse={() => void draft.browse()}
                      onReset={draft.resetCapturesDir}
                    />
                  )}
                  {draft.step === 1 && (
                    <ThemeStep value={draft.theme} onChange={draft.setTheme} />
                  )}
                  {draft.step === 2 && (
                    <AccentStep
                      value={draft.accent}
                      onChange={draft.setAccent}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            {draft.error && (
              <p
                role="alert"
                className="mt-4 rounded-md bg-[color:color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-2.5 py-1.5 text-[12px] text-[var(--color-accent)]"
              >
                {draft.error}
              </p>
            )}

            <div className="mt-8 flex items-center justify-between">
              <button
                type="button"
                onClick={draft.back}
                disabled={draft.step === 0 || draft.saving}
                className="focus-ring inline-flex h-9 items-center gap-1 rounded-[10px] border border-[color:var(--hairline)] bg-[var(--color-surface)] px-3 text-[12.5px] font-medium text-[var(--color-ink)] shadow-[var(--shadow-subtle)] transition-shadow hover:shadow-[var(--shadow-medium)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft size={14} strokeWidth={1.85} />
                Back
              </button>
              <button
                type="button"
                onClick={draft.next}
                disabled={draft.saving}
                className="focus-ring inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-[var(--color-accent)] px-4 text-[12.5px] font-semibold text-[var(--color-accent-ink)] shadow-[var(--shadow-subtle)] transition-shadow hover:shadow-[var(--shadow-medium)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {draft.step === 2 ? (
                  <>
                    <Rocket size={14} strokeWidth={1.85} />
                    {draft.saving ? "Setting up…" : "Get started"}
                  </>
                ) : (
                  <>
                    Next
                    <ChevronRight size={14} strokeWidth={1.85} />
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </WindowFrame>
  );
}
