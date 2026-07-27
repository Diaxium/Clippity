/**
 * "What's new" card — a small release spotlight. The version is read
 * live from the Tauri runtime; the summary is a static tagline (there is
 * no changelog service to pull from yet). "Open settings" points at the
 * place updates and models live.
 */

import { Rocket } from "lucide-react";

import { SectionCard, SectionHeading } from "./primitives";

interface WhatsNewProps {
  version: string | null;
  onOpenSettings: () => void;
}

export function WhatsNew({ version, onOpenSettings }: WhatsNewProps) {
  return (
    <SectionCard>
      <SectionHeading title="What's new" />

      <div
        className="mt-3 grid h-24 place-items-center overflow-hidden rounded-[12px] border border-[color:var(--hairline)]"
        style={{
          backgroundImage:
            "radial-gradient(120% 120% at 50% 20%, color-mix(in srgb, var(--color-tile-violet) 90%, transparent) 0%, transparent 70%)",
        }}
      >
        <Rocket
          size={34}
          strokeWidth={1.7}
          className="text-[var(--color-tile-violet-ink)]"
        />
      </div>

      <p className="mt-3 text-[14px] font-semibold text-[var(--color-ink)]">
        {version ? `Version ${version}` : "Clippity"}
      </p>
      <p className="mt-1 text-[12.5px] leading-snug text-[var(--color-slate)]">
        Modern screen capture, annotation, and workflow automation.
      </p>

      <button
        type="button"
        onClick={onOpenSettings}
        className="focus-ring mt-4 flex h-9 items-center justify-center rounded-[10px] border border-[color:var(--hairline-strong)] text-[13px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-overlay-1)]"
      >
        Open settings
      </button>
    </SectionCard>
  );
}
