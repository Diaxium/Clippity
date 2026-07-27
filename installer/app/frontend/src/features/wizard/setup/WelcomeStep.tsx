import { ChevronRight, HelpCircle } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@shared/ui";
import { openPath } from "@services/tauri";
import { useThemeStore } from "@state/themeStore";
import { useWizardStore } from "@state/wizardStore";
import { LINKS, PRODUCT } from "@config/catalog";

import heroDark from "@assets/heros/Hero-dark.png";
import heroLight from "@assets/heros/Hero-light.png";

/**
 * Setup step 1 — a hero welcome. Product art, a one-line pitch, the
 * version badge, and the single call to action that opens the flow.
 */
export function WelcomeStep() {
  const dark = useThemeStore((s) => s.theme === "dark");
  const goToStep = useWizardStore((s) => s.goToStep);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
        <motion.img
          src={dark ? heroDark : heroLight}
          alt=""
          aria-hidden
          width={168}
          height={168}
          draggable={false}
          className="h-[168px] w-[168px] object-contain drop-shadow-[0_18px_44px_rgba(0,0,0,0.35)]"
          initial={{ opacity: 0, scale: 0.9, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        />

        <h1 className="mt-6 text-[24px] font-semibold tracking-tight text-[var(--color-ink)]">
          Welcome to Clippity Setup
        </h1>
        <p className="mt-2 max-w-[360px] text-[13.5px] leading-relaxed text-[var(--color-slate)]">
          Clippity is the smart way to capture, organize, and share your ideas.
        </p>

        <div className="mt-4 flex items-center gap-2 text-[12px] text-[var(--color-hint)]">
          <span>Version {PRODUCT.version}</span>
          <span className="rounded-full bg-[var(--color-overlay-2)] px-2 py-0.5 font-medium text-[var(--color-slate)]">
            {PRODUCT.arch}
          </span>
        </div>

        <Button
          size="lg"
          className="mt-7 w-[280px]"
          onClick={() => goToStep("options")}
        >
          Install Clippity
          <ChevronRight size={16} strokeWidth={2} />
        </Button>
      </div>

      <div className="flex items-center px-7 py-4">
        <button
          type="button"
          onClick={() => void openPath(LINKS.help)}
          className="flex items-center gap-1.5 text-[12px] text-[var(--color-hint)] transition-colors hover:text-[var(--color-slate)]"
        >
          <HelpCircle size={13} strokeWidth={1.9} />
          Need help?
        </button>
      </div>
    </div>
  );
}
