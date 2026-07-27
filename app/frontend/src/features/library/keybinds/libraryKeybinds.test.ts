import { describe, expect, it } from "vitest";

import {
  LIBRARY_KEYBINDS,
  findLibraryKeybindConflicts,
  resolveLibraryKeyDown,
} from "./libraryKeybinds";

/** A keydown carrying the layout-stable `code` the matcher reads. */
function keydown(
  code: string,
  key: string,
  mods: { ctrl?: boolean; shift?: boolean } = {}
) {
  return new KeyboardEvent("keydown", {
    code,
    key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
  });
}

const IDLE = { typing: false, hasSelection: false };
const SELECTING = { typing: false, hasSelection: true };

describe("library keybinds", () => {
  it("has no two bindings sharing a key in the same context", () => {
    expect(findLibraryKeybindConflicts()).toEqual([]);
  });

  it("every binding has a command and a label", () => {
    for (const kb of LIBRARY_KEYBINDS) {
      expect(kb.onKeyDown, kb.id).toBeTypeOf("function");
      expect(kb.label, kb.id).toBeTruthy();
      expect(kb.keys.length, kb.id).toBeGreaterThan(0);
    }
  });

  it("Mod+A selects all whether or not anything is selected", () => {
    const e = keydown("KeyA", "a", { ctrl: true });
    expect(resolveLibraryKeyDown(e, IDLE)?.id).toBe("select-all");
    expect(resolveLibraryKeyDown(e, SELECTING)?.id).toBe("select-all");
  });

  it("Mod+Shift+A deselects, but only when there is a selection", () => {
    const e = keydown("KeyA", "a", { ctrl: true, shift: true });
    expect(resolveLibraryKeyDown(e, IDLE)).toBeNull();
    expect(resolveLibraryKeyDown(e, SELECTING)?.id).toBe("deselect-all");
  });

  it("Escape clears a selection and is otherwise left alone", () => {
    // It must fall through when nothing is selected — Escape is also how
    // the search box and the popovers back out.
    const e = keydown("Escape", "Escape");
    expect(resolveLibraryKeyDown(e, IDLE)).toBeNull();
    expect(resolveLibraryKeyDown(e, SELECTING)?.id).toBe("clear-selection");
  });

  it("Escape does not preventDefault, so other surfaces still see it", () => {
    const kb = LIBRARY_KEYBINDS.find((b) => b.id === "clear-selection");
    expect(kb?.preventDefault).toBe(false);
  });

  it("Delete and Backspace both trash the selection", () => {
    for (const [code, key] of [
      ["Delete", "Delete"],
      ["Backspace", "Backspace"],
    ] as const) {
      const e = keydown(code, key);
      expect(resolveLibraryKeyDown(e, IDLE)).toBeNull();
      expect(resolveLibraryKeyDown(e, SELECTING)?.id).toBe("trash-selection");
    }
  });

  it("nothing fires while the user is typing", () => {
    const typing = { typing: true, hasSelection: true };
    expect(
      resolveLibraryKeyDown(keydown("KeyA", "a", { ctrl: true }), typing)
    ).toBeNull();
    expect(
      resolveLibraryKeyDown(keydown("Delete", "Delete"), typing)
    ).toBeNull();
    expect(
      resolveLibraryKeyDown(keydown("Escape", "Escape"), typing)
    ).toBeNull();
  });

  it("an unbound key resolves to nothing", () => {
    expect(resolveLibraryKeyDown(keydown("KeyQ", "q"), SELECTING)).toBeNull();
  });
});
