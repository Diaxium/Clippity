import { describe, expect, it } from "vitest";

import type { ToastPayload } from "@clippity/shared";

import { rendersOwnChrome } from "./modes";

describe("rendersOwnChrome", () => {
  it("exempts both session HUDs from the toast shell", () => {
    // The scroll stitcher's and the recorder's. Each renders its own
    // floating cards, so wrapping them nests a card inside a card and
    // clips the result — which is how the recorder HUD first shipped.
    expect(rendersOwnChrome("recording")).toBe(true);
    expect(rendersOwnChrome("recorder")).toBe(true);
  });

  it("keeps the shell for every ordinary toast", () => {
    // These have no controls of their own, so they need the card's
    // padding and the chrome's ✕ to be dismissible at all.
    const ordinary: ToastPayload["kind"][] = [
      "error",
      "clipboard",
      "color",
      "palette",
      "text",
    ];
    for (const kind of ordinary) {
      expect(rendersOwnChrome(kind), kind).toBe(false);
    }
  });

  it("covers every kind the wire shape can carry", () => {
    // A kind added without a decision here silently gets the shell —
    // fine for a normal toast, wrong for a HUD, and invisible until
    // someone looks at a clipped window.
    const all: ToastPayload["kind"][] = [
      "error",
      "clipboard",
      "color",
      "palette",
      "text",
      "recording",
      "recorder",
    ];
    for (const kind of all) {
      expect(typeof rendersOwnChrome(kind), kind).toBe("boolean");
    }
  });
});
