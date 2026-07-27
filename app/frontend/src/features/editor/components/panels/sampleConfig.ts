import type { SampleMode } from "../../types";

/** Per-mode UI config for the Blur / Pixelate / Magnifier "sample" regions:
 *  the section/effect title plus the amount field's label, unit, and bounds.
 *  Shared by the annotate-mode `SampleSection` and the design-mode Effects row
 *  (see ADR 0015) so both read identically. */
export const SAMPLE_CFG: Record<
  SampleMode,
  { title: string; label: string; suffix: string; min: number; step: number }
> = {
  blur: { title: "Blur", label: "Amount", suffix: "px", min: 0, step: 1 },
  pixelate: {
    title: "Pixelate",
    label: "Cell size",
    suffix: "px",
    min: 2,
    step: 1,
  },
  magnify: {
    title: "Magnifier",
    label: "Zoom",
    suffix: "×",
    min: 1,
    step: 0.1,
  },
};

/** Sample modes in the order they appear in the effect-type dropdown. */
export const SAMPLE_MODES: readonly SampleMode[] = [
  "blur",
  "pixelate",
  "magnify",
];
