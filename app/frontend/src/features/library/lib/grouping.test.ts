import { describe, expect, it } from "vitest";

import type { CaptureMeta, Collection } from "../types";
import {
  allTags,
  collectionItems,
  filterCaptures,
  groupByDay,
  hasTag,
  matchesSearch,
  type LibraryFilter,
} from "./grouping";

function meta(over: Partial<CaptureMeta>): CaptureMeta {
  return {
    id: "/tmp/x.png",
    title: "x",
    kind: "image",
    createdAtMs: 0,
    sizeBytes: 0,
    trashed: false,
    ...over,
  };
}

function filter(over: Partial<LibraryFilter> = {}): LibraryFilter {
  return {
    mode: "library",
    kindFilter: "all",
    favoritesOnly: false,
    tagFilter: null,
    ...over,
  };
}

describe("filterCaptures", () => {
  const items = [
    meta({ id: "a", kind: "image", trashed: false }),
    meta({ id: "b", kind: "video", trashed: false }),
    meta({ id: "c", kind: "image", trashed: true }),
  ];

  it("library mode shows only non-trashed", () => {
    expect(filterCaptures(items, filter()).map((m) => m.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("trash mode shows only trashed", () => {
    const out = filterCaptures(items, filter({ mode: "trash" }));
    expect(out.map((m) => m.id)).toEqual(["c"]);
  });

  it("kind filter narrows within the mode", () => {
    const out = filterCaptures(items, filter({ kindFilter: "video" }));
    expect(out.map((m) => m.id)).toEqual(["b"]);
  });

  it("favorites-only keeps just the starred", () => {
    const starred = [
      meta({ id: "star", favorite: true }),
      meta({ id: "plain" }),
    ];
    const out = filterCaptures(starred, filter({ favoritesOnly: true }));
    expect(out.map((m) => m.id)).toEqual(["star"]);
  });

  it("a tag filter matches regardless of case", () => {
    // The backend keeps the spelling the user typed but treats tags
    // case-insensitively; an exact-match filter would empty the grid for
    // a tag plainly visible on the cards.
    const tagged = [
      meta({ id: "bug", tags: ["Bug"] }),
      meta({ id: "docs", tags: ["docs"] }),
      meta({ id: "none" }),
    ];
    const out = filterCaptures(tagged, filter({ tagFilter: "bUg" }));
    expect(out.map((m) => m.id)).toEqual(["bug"]);
  });

  it("refinements intersect rather than replace one another", () => {
    const mixed = [
      meta({ id: "hit", kind: "image", favorite: true, tags: ["bug"] }),
      meta({ id: "wrong-kind", kind: "video", favorite: true, tags: ["bug"] }),
      meta({ id: "unstarred", kind: "image", tags: ["bug"] }),
      meta({ id: "untagged", kind: "image", favorite: true }),
    ];
    const out = filterCaptures(
      mixed,
      filter({ kindFilter: "image", favoritesOnly: true, tagFilter: "bug" })
    );
    expect(out.map((m) => m.id)).toEqual(["hit"]);
  });
});

describe("matchesSearch", () => {
  it("matches the title, tags and provenance, ignoring case", () => {
    const m = meta({
      title: "clippity-123",
      tags: ["Bug Report"],
      sourceApp: "Chrome",
      sourceWindow: "Pricing — Figma",
    });
    expect(matchesSearch(m, "clippity")).toBe(true);
    expect(matchesSearch(m, "bug report")).toBe(true);
    expect(matchesSearch(m, "chrome")).toBe(true);
    expect(matchesSearch(m, "figma")).toBe(true);
    expect(matchesSearch(m, "nothing")).toBe(false);
  });

  it("searches an aux entry's payload, which its title never carries", () => {
    // A generated title (`aux_color_1712…`) is unsearchable, so the
    // content is the only handle these kinds have.
    const color = meta({
      kind: "color",
      title: "#ff6e4a",
      color: { hex: "#ff6e4a", r: 255, g: 110, b: 74 },
    });
    expect(matchesSearch(color, "#ff6e")).toBe(true);

    const text = meta({
      kind: "text",
      title: "aux",
      text: "npm run tauri:dev",
    });
    expect(matchesSearch(text, "tauri")).toBe(true);
  });

  it("finds a palette by any one of its swatches", () => {
    const palette = meta({
      kind: "palette",
      title: "aux",
      palette: [
        { hex: "#112233", r: 17, g: 34, b: 51 },
        { hex: "#ff6e4a", r: 255, g: 110, b: 74 },
      ],
    });
    expect(matchesSearch(palette, "#ff6e4a")).toBe(true);
    expect(matchesSearch(palette, "#999999")).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(matchesSearch(meta({}), "")).toBe(true);
  });
});

describe("hasTag", () => {
  it("ignores case and surrounding space", () => {
    expect(hasTag(meta({ tags: ["Bug Report"] }), "  bug report ")).toBe(true);
  });

  it("is false for a blank query or an untagged capture", () => {
    expect(hasTag(meta({ tags: ["bug"] }), "   ")).toBe(false);
    expect(hasTag(meta({}), "bug")).toBe(false);
  });
});

describe("allTags", () => {
  it("collects distinct tags, sorted, first spelling kept", () => {
    const items = [
      meta({ id: "1", tags: ["Zebra", "alpha"] }),
      meta({ id: "2", tags: ["ALPHA", "mid"] }),
      meta({ id: "3" }),
    ];
    expect(allTags(items)).toEqual(["alpha", "mid", "Zebra"]);
  });

  it("is empty when nothing is tagged", () => {
    expect(allTags([meta({})])).toEqual([]);
  });
});

describe("collectionItems", () => {
  const collection: Collection = {
    id: "col_1",
    name: "Walkthrough",
    createdAtMs: 0,
    updatedAtMs: 0,
    members: ["c", "a", "b"],
  };

  it("returns the members in curated order, not list order", () => {
    const items = [meta({ id: "a" }), meta({ id: "b" }), meta({ id: "c" })];
    expect(collectionItems(items, collection).map((m) => m.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("skips members whose capture isn't in the list", () => {
    // Trashed while the collection was open, or on an unmounted drive —
    // the collection keeps the id, the view just doesn't render it.
    const items = [meta({ id: "a" }), meta({ id: "c" })];
    expect(collectionItems(items, collection).map((m) => m.id)).toEqual([
      "c",
      "a",
    ]);
  });

  it("returns nothing for an empty collection", () => {
    expect(
      collectionItems([meta({ id: "a" })], { ...collection, members: [] })
    ).toEqual([]);
  });
});

describe("groupByDay", () => {
  it("groups items by calendar day, newest day first", () => {
    const day1 = new Date(2024, 0, 1, 10, 0).getTime();
    const day1b = new Date(2024, 0, 1, 18, 0).getTime();
    const day2 = new Date(2024, 0, 2, 9, 0).getTime();
    const items = [
      meta({ id: "older", createdAtMs: day1 }),
      meta({ id: "older2", createdAtMs: day1b }),
      meta({ id: "newer", createdAtMs: day2 }),
    ];
    const grouped = groupByDay(items);
    expect(grouped).toHaveLength(2);
    // Newest day first.
    expect(grouped[0]![1].map((m) => m.id)).toEqual(["newer"]);
    expect(grouped[1]![1].map((m) => m.id)).toEqual(["older", "older2"]);
  });

  it("returns an empty array for no items", () => {
    expect(groupByDay([])).toEqual([]);
  });
});
