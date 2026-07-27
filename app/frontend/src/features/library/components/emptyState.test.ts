import { describe, expect, it } from "vitest";

import { emptyStateMessage, type EmptyStateContext } from "./EmptyState";

function ctx(over: Partial<EmptyStateContext> = {}): EmptyStateContext {
  return {
    mode: "library",
    kindFilter: "all",
    favoritesOnly: false,
    tagFilter: null,
    collectionName: null,
    ...over,
  };
}

describe("emptyStateMessage", () => {
  it("names the trash before anything else", () => {
    expect(emptyStateMessage(ctx({ mode: "trash", tagFilter: "bug" }))).toBe(
      "Deleted captures show up here."
    );
  });

  it("names the narrowest active refinement", () => {
    // With several filters on, the one the user most recently reached
    // for is the one they can undo — pointing at "no captures" would be
    // false with a full library sitting behind the filter.
    expect(
      emptyStateMessage(
        ctx({ tagFilter: "bug", favoritesOnly: true, kindFilter: "image" })
      )
    ).toContain("bug");
    expect(
      emptyStateMessage(ctx({ favoritesOnly: true, kindFilter: "image" }))
    ).toContain("favorites");
    expect(
      emptyStateMessage(ctx({ collectionName: "Walkthrough" }))
    ).toContain("Walkthrough");
    expect(emptyStateMessage(ctx({ kindFilter: "video" }))).toContain("videos");
  });

  it("falls back to the plain empty library", () => {
    expect(emptyStateMessage(ctx())).toBe("Your captures will appear here.");
  });
});
