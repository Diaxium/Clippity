import { describe, expect, it } from "vitest";

import {
  imageAlignFractions,
  imageAlignToken,
  imagePreserveAspectRatio,
} from "./imageFill";

describe("image-fill alignment", () => {
  it("maps alignments to anchor fractions", () => {
    expect(imageAlignFractions("center")).toEqual({ ax: 0.5, ay: 0.5 });
    expect(imageAlignFractions("top-left")).toEqual({ ax: 0, ay: 0 });
    expect(imageAlignFractions("bottom-right")).toEqual({ ax: 1, ay: 1 });
    expect(imageAlignFractions("right")).toEqual({ ax: 1, ay: 0.5 });
    expect(imageAlignFractions("top")).toEqual({ ax: 0.5, ay: 0 });
  });

  it("builds SVG align tokens", () => {
    expect(imageAlignToken("center")).toBe("xMidYMid");
    expect(imageAlignToken("top-left")).toBe("xMinYMin");
    expect(imageAlignToken("bottom-right")).toBe("xMaxYMax");
  });

  it("builds preserveAspectRatio per scale", () => {
    expect(imagePreserveAspectRatio("fill", "center")).toBe("xMidYMid slice");
    expect(imagePreserveAspectRatio("fit", "center")).toBe("xMidYMid meet");
    expect(imagePreserveAspectRatio("stretch", "center")).toBe("none");
    expect(imagePreserveAspectRatio("fill", "top-left")).toBe("xMinYMin slice");
  });
});
