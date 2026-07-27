import { describe, expect, it } from "vitest";

import type { CaptureMeta } from "../types";
import { auxClipboardText } from "./auxClipboard";

function meta(partial: Partial<CaptureMeta>): CaptureMeta {
  return {
    id: "x",
    title: "x",
    kind: "image",
    createdAtMs: 0,
    sizeBytes: 0,
    trashed: false,
    ...partial,
  };
}

describe("auxClipboardText", () => {
  it("returns the hex for a color entry", () => {
    const m = meta({
      kind: "color",
      color: { hex: "#FF0000", r: 255, g: 0, b: 0 },
    });
    expect(auxClipboardText(m)).toBe("#FF0000");
  });

  it("joins palette hexes with commas", () => {
    const m = meta({
      kind: "palette",
      palette: [
        { hex: "#FF0000", r: 255, g: 0, b: 0 },
        { hex: "#00FF00", r: 0, g: 255, b: 0 },
      ],
    });
    expect(auxClipboardText(m)).toBe("#FF0000, #00FF00");
  });

  it("returns the content for a text entry", () => {
    expect(auxClipboardText(meta({ kind: "text", text: "hello" }))).toBe(
      "hello"
    );
  });

  it("returns null for a file-backed entry", () => {
    expect(auxClipboardText(meta({ kind: "image" }))).toBeNull();
  });

  it("returns null when the aux payload is missing", () => {
    expect(auxClipboardText(meta({ kind: "color" }))).toBeNull();
  });
});
