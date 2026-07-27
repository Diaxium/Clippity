import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetKeybindOverridesForTest,
  applyOverrides,
  effectiveKeys,
  fqid,
  getKeybindOverrides,
  keybindOverridesVersion,
  setKeybindOverrides,
  subscribeKeybindOverrides,
} from "./overrides";

afterEach(() => {
  __resetKeybindOverridesForTest();
});

describe("fqid", () => {
  it("joins scope and id with a colon", () => {
    expect(fqid("editor", "select-all")).toBe("editor:select-all");
  });
});

describe("effectiveKeys", () => {
  it("returns a copy of the defaults when no override exists", () => {
    const defaults = ["Mod+A"];
    const out = effectiveKeys("editor", "select-all", defaults, {});
    expect(out).toEqual(["Mod+A"]);
    expect(out).not.toBe(defaults); // a copy, safe to mutate
  });

  it("returns the override when present", () => {
    const out = effectiveKeys("editor", "undo", ["Mod+Z"], {
      "editor:undo": ["Mod+Shift+U"],
    });
    expect(out).toEqual(["Mod+Shift+U"]);
  });

  it("treats an explicit empty override as deliberately unbound", () => {
    const out = effectiveKeys("library", "trash-selection", ["Delete"], {
      "library:trash-selection": [],
    });
    expect(out).toEqual([]);
  });
});

describe("applyOverrides", () => {
  const bindings: { id: string; keys: string[] }[] = [
    { id: "a", keys: ["Mod+A"] },
    { id: "b", keys: ["Mod+B"] },
  ];

  it("returns the same array reference when nothing is overridden", () => {
    expect(applyOverrides("library", bindings, {})).toBe(bindings);
  });

  it("swaps only the overridden binding's keys, leaving others by reference", () => {
    const out = applyOverrides("library", bindings, {
      "library:a": ["Ctrl+1"],
    });
    expect(out).not.toBe(bindings);
    expect(out[0]).toEqual({ id: "a", keys: ["Ctrl+1"] });
    expect(out[1]).toBe(bindings[1]);
  });
});

describe("live override store", () => {
  it("bumps the version and notifies on a real change", () => {
    const listener = vi.fn();
    const unsub = subscribeKeybindOverrides(listener);
    const before = keybindOverridesVersion();

    setKeybindOverrides({ "editor:undo": ["Mod+U"] });

    expect(keybindOverridesVersion()).toBe(before + 1);
    expect(getKeybindOverrides()).toEqual({ "editor:undo": ["Mod+U"] });
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("is a no-op when the new map is value-equal to the current one", () => {
    setKeybindOverrides({ "editor:undo": ["Mod+U"] });
    const listener = vi.fn();
    subscribeKeybindOverrides(listener);
    const version = keybindOverridesVersion();

    // A fresh object with identical contents must not bump or notify.
    setKeybindOverrides({ "editor:undo": ["Mod+U"] });

    expect(keybindOverridesVersion()).toBe(version);
    expect(listener).not.toHaveBeenCalled();
  });

  it("treats undefined as an empty map", () => {
    setKeybindOverrides({ "editor:undo": ["Mod+U"] });
    setKeybindOverrides(undefined);
    expect(getKeybindOverrides()).toEqual({});
  });
});
