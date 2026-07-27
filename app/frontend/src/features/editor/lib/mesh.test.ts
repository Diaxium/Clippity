import { describe, expect, it } from "vitest";

import { meshColorAt, meshColorAtWarped, meshNodes, meshSources } from "./mesh";
import { makeMesh, resizeMesh, type MeshSpec } from "../types";

const corners: MeshSpec = {
  rows: 2,
  cols: 2,
  points: [
    { color: "#ff0000", opacity: 1 }, // TL red
    { color: "#00ff00", opacity: 1 }, // TR green
    { color: "#0000ff", opacity: 1 }, // BL blue
    { color: "#ffffff", opacity: 1 }, // BR white
  ],
};

describe("meshColorAt", () => {
  const s = meshSources(corners);

  it("returns the cell colors at the corners", () => {
    expect(meshColorAt(s, 2, 2, 0, 0)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(meshColorAt(s, 2, 2, 1, 0)).toMatchObject({ r: 0, g: 255, b: 0 });
    expect(meshColorAt(s, 2, 2, 0, 1)).toMatchObject({ r: 0, g: 0, b: 255 });
    expect(meshColorAt(s, 2, 2, 1, 1)).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("blends to the four-corner average at the center", () => {
    const c = meshColorAt(s, 2, 2, 0.5, 0.5);
    expect(c.r).toBeCloseTo(127.5, 1);
    expect(c.g).toBeCloseTo(127.5, 1);
    expect(c.b).toBeCloseTo(127.5, 1);
  });
});

describe("meshColorAtWarped", () => {
  // A 2×2 grid on its uniform positions must match the plain bilinear blend.
  const mesh: MeshSpec = {
    rows: 2,
    cols: 2,
    points: [
      { color: "#ff0000", opacity: 1, point: { x: 0, y: 0 } },
      { color: "#00ff00", opacity: 1, point: { x: 1, y: 0 } },
      { color: "#0000ff", opacity: 1, point: { x: 0, y: 1 } },
      { color: "#ffffff", opacity: 1, point: { x: 1, y: 1 } },
    ],
  };

  it("reduces to uniform bilinear when points sit on the grid", () => {
    const nodes = meshNodes(mesh);
    const sources = meshSources(mesh);
    const samples: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0.5],
      [0.3, 0.7],
    ];
    for (const [u, v] of samples) {
      const w = meshColorAtWarped(nodes, 2, 2, u, v);
      const b = meshColorAt(sources, 2, 2, u, v);
      expect(w.r).toBeCloseTo(b.r, 4);
      expect(w.g).toBeCloseTo(b.g, 4);
      expect(w.b).toBeCloseTo(b.b, 4);
    }
  });

  it("follows a dragged node — its color tracks to the new position", () => {
    // Before the drag, the center is the four-corner average (mid-grey).
    const before = meshColorAtWarped(meshNodes(mesh), 2, 2, 0.5, 0.5);
    expect(before.r).toBeCloseTo(127.5, 0);
    expect(before.g).toBeCloseTo(127.5, 0);
    expect(before.b).toBeCloseTo(127.5, 0);
    // Pull the white BR node to the box center; the center now reads near-white.
    const warped: MeshSpec = {
      ...mesh,
      points: mesh.points.map((p, i) =>
        i === 3 ? { ...p, point: { x: 0.5, y: 0.5 } } : p
      ),
    };
    const after = meshColorAtWarped(meshNodes(warped), 2, 2, 0.5, 0.5);
    expect(after.r).toBeGreaterThan(230);
    expect(after.g).toBeGreaterThan(230);
    expect(after.b).toBeGreaterThan(230);
  });

  it("fills the whole box (no transparent holes) when a node is pulled in", () => {
    const warped: MeshSpec = {
      ...mesh,
      points: mesh.points.map((p, i) =>
        i === 3 ? { ...p, point: { x: 0.5, y: 0.5 } } : p
      ),
    };
    const nodes = meshNodes(warped);
    // The far corner is outside the shrunken quad, but clamps to an edge color.
    expect(meshColorAtWarped(nodes, 2, 2, 1, 1).a).toBeGreaterThan(0);
  });
});

describe("meshSources", () => {
  it("converts each cell to 0..255 rgba", () => {
    const s = meshSources({
      rows: 1,
      cols: 1,
      points: [{ color: "#ff0000", opacity: 0.5 }],
    });
    expect(s[0]).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(s[0]!.a).toBeCloseTo(127.5, 1);
  });
});

describe("resizeMesh", () => {
  it("grows by extending edge colors, preserving overlap", () => {
    const m = makeMesh(); // 2×2
    const bigger = resizeMesh(m, 3, 3);
    expect(bigger.rows).toBe(3);
    expect(bigger.cols).toBe(3);
    expect(bigger.points).toHaveLength(9);
    expect(bigger.points[0]!.color).toBe(m.points[0]!.color); // top-left kept
  });

  it("clamps the grid to 1..8", () => {
    const m = makeMesh();
    expect(resizeMesh(m, 100, 100).rows).toBe(8);
    expect(resizeMesh(m, 0, 0).cols).toBe(1);
  });
});
