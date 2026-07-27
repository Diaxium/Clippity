import { describe, expect, it } from "vitest";

import {
  ACCENT_INK_DARK,
  ACCENT_INK_LIGHT,
  accentInk,
  inferPrefFromExplicit,
  resolveTheme,
} from "./theme";

describe("resolveTheme", () => {
  it("returns the explicit pref unchanged", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("falls back to OS prefs when pref is system + dark", () => {
    expect(resolveTheme("system", true)).toBe("dark");
  });

  it("falls back to OS prefs when pref is system + light", () => {
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("inferPrefFromExplicit", () => {
  it("keeps system when user picks the OS-resolved theme", () => {
    expect(inferPrefFromExplicit("system", "dark", true)).toBe("system");
    expect(inferPrefFromExplicit("system", "light", false)).toBe("system");
  });

  it("flips system → explicit when user dissents from OS", () => {
    expect(inferPrefFromExplicit("system", "light", true)).toBe("light");
    expect(inferPrefFromExplicit("system", "dark", false)).toBe("dark");
  });

  it("passes through explicit picks unchanged", () => {
    expect(inferPrefFromExplicit("light", "dark", true)).toBe("dark");
    expect(inferPrefFromExplicit("dark", "light", false)).toBe("light");
  });
});

describe("accentInk", () => {
  it("keeps white on the dark brand accents (preserves identity)", () => {
    // Coral is the default brand accent and has always shipped white text.
    expect(accentInk("#FF6E4A")).toBe(ACCENT_INK_LIGHT);
    expect(accentInk("#2C3E3E")).toBe(ACCENT_INK_LIGHT); // Slate
  });

  it("flips to dark ink on the light brand presets (readability)", () => {
    // Teal / Lavender / Gold / Mint — all light enough that white text
    // would be unreadable on a solid fill.
    for (const hex of ["#A8D5D8", "#E8D9F2", "#D4C5B0", "#24D1B5"]) {
      expect(accentInk(hex)).toBe(ACCENT_INK_DARK);
    }
  });

  it("handles a light vs dark custom hex", () => {
    expect(accentInk("#ffffff")).toBe(ACCENT_INK_DARK);
    expect(accentInk("#000000")).toBe(ACCENT_INK_LIGHT);
  });

  it("tolerates a missing leading # and casing", () => {
    expect(accentInk("ff6e4a")).toBe(ACCENT_INK_LIGHT);
    expect(accentInk("e8d9f2")).toBe(ACCENT_INK_DARK);
  });

  it("falls back to white for an unparseable accent", () => {
    expect(accentInk("not-a-color")).toBe(ACCENT_INK_LIGHT);
    expect(accentInk("")).toBe(ACCENT_INK_LIGHT);
  });
});
