/**
 * Per-material backdrop tuning — tables + pure helpers.
 *
 * The backdrop picker is coarse: it chooses *which* DWM material the
 * window asks for, and the materials don't respond alike. Mica and
 * Tabbed are wallpaper-derived — DWM blurs the desktop *wallpaper*
 * once, so nothing behind the window (another app, video, a window
 * dragged past) ever shows through them however transparent the chrome
 * is made. Acrylic and Blur sample live content; Clear removes the
 * material entirely so the transparent window is a plain hole onto the
 * desktop. One set of numbers can't flatter all five, so each material
 * carries its own [`BackdropTuning`].
 *
 * This module is deliberately free of React and of the icon-laden
 * `constants.ts` table: `Providers.tsx` reads it on every window (all
 * six Tauri windows boot the same bundle), and the panel reads it too.
 *
 * Mirrors Rust `domain::settings::{BackdropTuning, BackdropTuningSet}`.
 * The envelopes here must stay in lock-step with the Rust
 * `{MIN,MAX}_BACKDROP_*_PCT` clamps — the backend re-clamps on save, so
 * a drift shows up as a slider that snaps back.
 */

import type {
  BackdropTuning,
  BackdropTuningSet,
  WindowBackdrop,
} from "../types";

/** Materials that sample live content behind the window rather than
 *  the wallpaper. Drives the panel's "this is why lowering transparency
 *  doesn't reveal your desktop" note. Mirrors Rust
 *  `WindowBackdrop::samples_live_content`. */
export const BACKDROP_SAMPLES_LIVE_CONTENT: Record<WindowBackdrop, boolean> = {
  mica: false,
  acrylic: true,
  blur: true,
  tabbed: false,
  clear: true,
};

/** Materials that take a tint colour. Mica / Tabbed are DWM system
 *  backdrops that tint themselves and Clear paints nothing, so the tint
 *  slider is hidden for those. Mirrors `WindowBackdrop::accepts_tint`. */
export const BACKDROP_ACCEPTS_TINT: Record<WindowBackdrop, boolean> = {
  mica: false,
  acrylic: true,
  blur: true,
  tabbed: false,
  clear: false,
};

/** Tuning envelopes, in percent. Mirror the Rust
 *  `domain::settings::{MIN,MAX}_BACKDROP_*_PCT` clamps. */
export const BACKDROP_TINT_MIN_PCT = 0;
export const BACKDROP_TINT_MAX_PCT = 100;
export const BACKDROP_GLASS_MIN_PCT = 0;
export const BACKDROP_GLASS_MAX_PCT = 150;
export const BACKDROP_BLUR_MIN_PCT = 0;
export const BACKDROP_BLUR_MAX_PCT = 200;
export const BACKDROP_SATURATION_MIN_PCT = 50;
export const BACKDROP_SATURATION_MAX_PCT = 200;
export const BACKDROP_TUNING_STEP_PCT = 5;

/** Shipped tuning for a tintable material. Mirrors Rust
 *  `BackdropTuning::default` — 70 % tint is the alpha the acrylic tint
 *  was hardcoded to, and the three scale knobs sit neutral so a fresh
 *  install renders exactly what it did before tuning existed. */
export const DEFAULT_BACKDROP_TUNING: BackdropTuning = {
  tintStrength: 70,
  glassStrength: 100,
  blurStrength: 100,
  saturation: 100,
};

/** Shipped tuning for every material that doesn't read a tint — Blur's
 *  was pinned to a visually-invisible alpha 1, Clear paints no material
 *  at all, and Mica / Tabbed are tinted by DWM itself. Mirrors Rust
 *  `default_untinted_tuning`. */
export const DEFAULT_UNTINTED_BACKDROP_TUNING: BackdropTuning = {
  ...DEFAULT_BACKDROP_TUNING,
  tintStrength: 0,
};

/** Shipped `backdropTuning` map. Mirrors Rust
 *  `BackdropTuningSet::default`. Doubles as the fallback before settings
 *  hydrate and as the source for the panel's "Reset" action. */
export const DEFAULT_BACKDROP_TUNING_SET: BackdropTuningSet = {
  mica: DEFAULT_UNTINTED_BACKDROP_TUNING,
  acrylic: DEFAULT_BACKDROP_TUNING,
  blur: DEFAULT_UNTINTED_BACKDROP_TUNING,
  tabbed: DEFAULT_UNTINTED_BACKDROP_TUNING,
  clear: DEFAULT_UNTINTED_BACKDROP_TUNING,
};

/** One tuning slider, as rendered by the Appearance panel. `key` is the
 *  `BackdropTuning` field it writes; `appliesTo` gates the row on the
 *  selected material. Order is display order — the knob most likely to
 *  fix "I can't see through it" comes first. */
export interface BackdropTuningControl {
  key: keyof BackdropTuning;
  label: string;
  description: string;
  min: number;
  max: number;
  appliesTo?: (backdrop: WindowBackdrop) => boolean;
}

export const BACKDROP_TUNING_CONTROLS: readonly BackdropTuningControl[] = [
  {
    key: "glassStrength",
    label: "Panel fill",
    description:
      "How solid the app's own panels stay over the material. Lower reveals more of it; 0 stops them painting.",
    min: BACKDROP_GLASS_MIN_PCT,
    max: BACKDROP_GLASS_MAX_PCT,
  },
  {
    key: "blurStrength",
    label: "Chrome blur",
    description:
      "Blur the app applies on top of the material. Lower reads sharper through the chrome.",
    min: BACKDROP_BLUR_MIN_PCT,
    max: BACKDROP_BLUR_MAX_PCT,
  },
  {
    key: "saturation",
    label: "Colour",
    description:
      "Pushes colour back into a material that washes out once the chrome above it goes transparent.",
    min: BACKDROP_SATURATION_MIN_PCT,
    max: BACKDROP_SATURATION_MAX_PCT,
  },
  {
    key: "tintStrength",
    label: "Material tint",
    description:
      "Alpha of the colour Windows blends into the material itself. Windows 10 and pre-22H2 builds only.",
    min: BACKDROP_TINT_MIN_PCT,
    max: BACKDROP_TINT_MAX_PCT,
    appliesTo: (backdrop) => BACKDROP_ACCEPTS_TINT[backdrop],
  },
] as const;

/** The tuning rows that do something for `backdrop`. */
export function backdropTuningControls(
  backdrop: WindowBackdrop
): readonly BackdropTuningControl[] {
  return BACKDROP_TUNING_CONTROLS.filter(
    (control) => control.appliesTo?.(backdrop) ?? true
  );
}

/** The shipped tuning for one material — what "Reset" restores. */
export function defaultBackdropTuning(
  backdrop: WindowBackdrop
): BackdropTuning {
  return DEFAULT_BACKDROP_TUNING_SET[backdrop] ?? DEFAULT_BACKDROP_TUNING;
}

/**
 * The tuning for one material, filled from that material's shipped
 * defaults. The fallback matters twice: before settings hydrate, and
 * for a `settings.json` written before a material or knob existed (the
 * Rust side fills those per field on load, but a window can read the
 * store before that lands).
 */
export function resolveBackdropTuning(
  set: BackdropTuningSet | undefined,
  backdrop: WindowBackdrop
): BackdropTuning {
  return { ...defaultBackdropTuning(backdrop), ...(set?.[backdrop] ?? {}) };
}

/** Write one material's tuning back into the full set, leaving the
 *  other materials' numbers alone. */
export function withBackdropTuning(
  set: BackdropTuningSet | undefined,
  backdrop: WindowBackdrop,
  tuning: BackdropTuning
): BackdropTuningSet {
  return { ...DEFAULT_BACKDROP_TUNING_SET, ...(set ?? {}), [backdrop]: tuning };
}
