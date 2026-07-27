import { afterEach, describe, expect, it } from "vitest";

import {
  __resetKeybindOverridesForTest,
  setKeybindOverrides,
} from "@shared/keybinds/overrides";

import { comboFromEvent } from "./keybindUtils";
import { effectiveEditorKeybinds, resolveKeyDown } from "./keybindRegistry";
import type { DispatchState } from "./keybindRegistry";

const ACTIVE: DispatchState = {
  typing: false,
  hasSelection: true,
  editingText: false,
};

afterEach(() => {
  __resetKeybindOverridesForTest();
});

describe("comboFromEvent", () => {
  it("builds an author combo from modifiers + main key", () => {
    const e = new KeyboardEvent("keydown", {
      code: "KeyD",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(comboFromEvent(e)).toBe("Mod+Shift+d");
  });

  it("returns null while only a modifier is held", () => {
    const e = new KeyboardEvent("keydown", {
      key: "Shift",
      code: "ShiftLeft",
      shiftKey: true,
    });
    expect(comboFromEvent(e)).toBeNull();
  });
});

describe("editor registry override application", () => {
  it("swaps a binding's combo when an override is set", () => {
    setKeybindOverrides({ "editor:undo": ["Mod+U"] });
    const undo = effectiveEditorKeybinds().find((kb) => kb.id === "undo");
    expect(undo?.keys).toEqual(["Mod+U"]);
    // Stale hand-authored helpKeys are cleared so chips regenerate.
    expect(undo?.helpKeys).toBeUndefined();
  });

  it("resolves the remapped combo and stops resolving the old one", () => {
    setKeybindOverrides({ "editor:undo": ["Mod+U"] });

    const remapped = new KeyboardEvent("keydown", { code: "KeyU", ctrlKey: true });
    expect(resolveKeyDown(remapped, ACTIVE)?.id).toBe("undo");

    // The default Mod+Z no longer triggers undo.
    const oldCombo = new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true });
    expect(resolveKeyDown(oldCombo, ACTIVE)?.id).not.toBe("undo");
  });

  it("falls back to defaults once the override is cleared", () => {
    setKeybindOverrides({ "editor:undo": ["Mod+U"] });
    setKeybindOverrides({});
    const defaultCombo = new KeyboardEvent("keydown", {
      code: "KeyZ",
      ctrlKey: true,
    });
    expect(resolveKeyDown(defaultCombo, ACTIVE)?.id).toBe("undo");
  });
});
