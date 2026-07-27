/**
 * Palette export formatting — pure, framework-free.
 *
 * Turns an extracted palette into the text a designer pastes elsewhere:
 * a hex list, `rgb()` / `hsl()` lines, CSS custom properties, a JSON
 * array, or a Tailwind `colors` snippet. Lives in `shared/lib` (not a
 * feature) because both the toast (`features/toast`) and the library
 * (`features/library`) copy palettes, and neither should import the
 * other. The input is the structural `{ hex, r, g, b }` shape that both
 * `AuxColor` and `PaletteSwatch` satisfy, so callers pass their own type
 * directly.
 *
 * Unit-tested in `paletteExport.test.ts`.
 */

/** The minimal swatch shape every export needs — satisfied structurally
 *  by both `AuxColor` (library) and `PaletteSwatch` (toast). */
export interface SwatchLike {
  hex: string;
  r: number;
  g: number;
  b: number;
}

/** Copy formats offered in the toast + library "Copy as" control. */
export type PaletteFormat =
  | "hex-list"
  | "rgb"
  | "hsl"
  | "css"
  | "json"
  | "tailwind";

export interface PaletteFormatDef {
  id: PaletteFormat;
  /** Short label for the format selector. */
  label: string;
}

/** Selector order — HEX first (the default + the legacy copy behavior). */
export const PALETTE_FORMATS: readonly PaletteFormatDef[] = [
  { id: "hex-list", label: "HEX" },
  { id: "rgb", label: "RGB" },
  { id: "hsl", label: "HSL" },
  { id: "css", label: "CSS vars" },
  { id: "json", label: "JSON" },
  { id: "tailwind", label: "Tailwind" },
];

/**
 * Convert 0-255 sRGB to HSL — hue in `[0, 360)`, saturation + lightness
 * as integer percents. Pure; the standard piecewise hue formula.
 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rn:
        h = (((gn - bn) / d) % 6 + 6) % 6;
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

/**
 * Render `colors` as a single clipboard string in `format`. One color per
 * line for the code-ish formats (rgb / hsl / css / tailwind); a
 * comma-separated run for `hex-list` (matches the legacy copy behavior);
 * a pretty JSON array of hex strings for `json`.
 */
export function formatPalette(
  colors: readonly SwatchLike[],
  format: PaletteFormat
): string {
  switch (format) {
    case "hex-list":
      return colors.map((c) => c.hex).join(", ");
    case "rgb":
      return colors.map((c) => `rgb(${c.r}, ${c.g}, ${c.b})`).join("\n");
    case "hsl":
      return colors
        .map((c) => {
          const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
          return `hsl(${h}, ${s}%, ${l}%)`;
        })
        .join("\n");
    case "css":
      return `:root {\n${colors
        .map((c, i) => `  --color-${i + 1}: ${c.hex};`)
        .join("\n")}\n}`;
    case "json":
      return JSON.stringify(
        colors.map((c) => c.hex),
        null,
        2
      );
    case "tailwind":
      return `colors: {\n${colors
        .map((c, i) => `  'palette-${i + 1}': '${c.hex}',`)
        .join("\n")}\n}`;
  }
}
