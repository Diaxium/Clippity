import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeImage,
  makeRectangle,
  type SceneNode,
} from "../types";
import { findBaseImage } from "./sample";

describe("findBaseImage", () => {
  it("returns null when the scene has no image", () => {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    expect(findBaseImage({ [r.id]: r })).toBeNull();
  });

  it("picks the largest-area image (the capture)", () => {
    __resetNodeIdForTests();
    const small = makeImage(
      { x: 0, y: 0, width: 10, height: 10 },
      "data:image/png;base64,SMALL"
    );
    const big = makeImage(
      { x: 0, y: 0, width: 100, height: 80 },
      "data:image/png;base64,BIG"
    );
    const nodes: Record<string, SceneNode> = {
      [small.id]: small,
      [big.id]: big,
    };
    const base = findBaseImage(nodes);
    expect(base?.src).toBe("data:image/png;base64,BIG");
    expect(base?.rect.width).toBe(100);
    expect(base?.rect.height).toBe(80);
  });
});
