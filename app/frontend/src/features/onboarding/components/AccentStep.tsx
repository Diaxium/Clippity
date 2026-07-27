import { Palette } from "lucide-react";

import { AccentPicker } from "@features/settings/components/AccentPicker";

import { StepHeader } from "./StepHeader";

interface AccentStepProps {
  value: string;
  onChange(next: string): void;
}

/**
 * Step 3 — accent colour. Re-uses the settings panel's `AccentPicker`
 * (presets + custom hex input). Changes preview live through the
 * settings store, exactly like the theme step.
 */
export function AccentStep({ value, onChange }: AccentStepProps) {
  return (
    <div>
      <StepHeader
        icon={Palette}
        title="Choose your accent"
        description="Highlights, active states, and the capture button glow follow this color."
      />
      <AccentPicker value={value} onChange={onChange} />
    </div>
  );
}
