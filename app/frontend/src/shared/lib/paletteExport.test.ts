import { describe, expect, it } from "vitest";

import {
  formatPalette,
  rgbToHsl,
  type SwatchLike,
} from "./paletteExport";

const PALETTE: SwatchLike[] = [
  { hex: "#FF0000", r: 255, g: 0, b: 0 },
  { hex: "#00FF00", r: 0, g: 255, b: 0 },
];

describe("rgbToHsl", () => {
  it("maps the primaries onto the hue wheel", () => {
    expect(rgbToHsl(255, 0, 0)).toEqual([0, 100, 50]);
    expect(rgbToHsl(0, 255, 0)).toEqual([120, 100, 50]);
    expect(rgbToHsl(0, 0, 255)).toEqual([240, 100, 50]);
  });

  it("reports grays as zero-saturation", () => {
    expect(rgbToHsl(128, 128, 128)).toEqual([0, 0, 50]);
    expect(rgbToHsl(0, 0, 0)).toEqual([0, 0, 0]);
    expect(rgbToHsl(255, 255, 255)).toEqual([0, 0, 100]);
  });
});

describe("formatPalette", () => {
  it("hex-list joins with comma+space (legacy copy behavior)", () => {
    expect(formatPalette(PALETTE, "hex-list")).toBe("#FF0000, #00FF00");
  });

  it("rgb emits one functional notation per line", () => {
    expect(formatPalette(PALETTE, "rgb")).toBe(
      "rgb(255, 0, 0)\nrgb(0, 255, 0)"
    );
  });

  it("hsl emits one functional notation per line", () => {
    expect(formatPalette(PALETTE, "hsl")).toBe(
      "hsl(0, 100%, 50%)\nhsl(120, 100%, 50%)"
    );
  });

  it("css wraps numbered custom properties in :root", () => {
    expect(formatPalette(PALETTE, "css")).toBe(
      ":root {\n  --color-1: #FF0000;\n  --color-2: #00FF00;\n}"
    );
  });

  it("json is a pretty array of hex strings", () => {
    expect(formatPalette(PALETTE, "json")).toBe(
      '[\n  "#FF0000",\n  "#00FF00"\n]'
    );
  });

  it("tailwind is a colors map keyed palette-N", () => {
    expect(formatPalette(PALETTE, "tailwind")).toBe(
      "colors: {\n  'palette-1': '#FF0000',\n  'palette-2': '#00FF00',\n}"
    );
  });

  it("handles an empty palette without throwing", () => {
    expect(formatPalette([], "hex-list")).toBe("");
    expect(formatPalette([], "json")).toBe("[]");
    expect(formatPalette([], "css")).toBe(":root {\n\n}");
  });
});
