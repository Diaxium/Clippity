import { describe, expect, it } from "vitest";

import { EDITOR_KEYBINDS } from "./editorKeybinds";
import type { EditorKeybind } from "./keybindTypes";
import {
  EDITOR_KEYBIND_CONFLICTS,
  keybindGroups,
  paletteCommands,
  resolveKeyDown,
  resolveKeyUp,
  type DispatchState,
} from "./keybindRegistry";
import {
  comboSigKey,
  findKeybindConflicts,
  formatCombo,
  IS_MAC,
  parseCombo,
} from "./keybindUtils";

const editor: DispatchState = {
  typing: false,
  hasSelection: false,
  editingText: false,
};
const withSelection: DispatchState = { ...editor, hasSelection: true };
const typing: DispatchState = { ...editor, typing: true };

interface KeyInit {
  key: string;
  code: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}
const ev = (init: KeyInit) => new KeyboardEvent("keydown", init);

describe("parseCombo + signatures", () => {
  it("parses modifiers and a layout-stable key token", () => {
    expect(parseCombo("Mod+Shift+]")).toEqual({
      mod: true,
      shift: true,
      alt: false,
      key: "]",
    });
    expect(parseCombo("V")).toEqual({
      mod: false,
      shift: false,
      alt: false,
      key: "v",
    });
    // "?" is authored as Shift+/ so it matches the event's Slash code.
    expect(parseCombo("Shift+/")).toMatchObject({ shift: true, key: "/" });
  });

  it("collapses Cmd and Ctrl into the same `Mod` signature", () => {
    expect(comboSigKey("Mod+C")).toBe(comboSigKey("Cmd+C"));
    expect(comboSigKey("Mod+C")).toBe(comboSigKey("Ctrl+C"));
  });
});

describe("formatCombo (platform-aware labels)", () => {
  it("renders the Mod label for the host platform", () => {
    const mod = IS_MAC ? "⌘" : "Ctrl";
    expect(formatCombo("Mod+Shift+]")).toEqual([mod, IS_MAC ? "⇧" : "Shift", "]"]);
    expect(formatCombo("Mod+D")).toEqual([mod, "D"]);
  });

  it("maps named keys to glyphs", () => {
    expect(formatCombo("ArrowUp")).toEqual(["↑"]);
    expect(formatCombo("Space")).toEqual(["Space"]);
    expect(formatCombo("Escape")).toEqual(["Esc"]);
  });
});

describe("conflict detection", () => {
  it("the default registry has no conflicts", () => {
    expect(findKeybindConflicts(EDITOR_KEYBINDS)).toEqual([]);
    expect(EDITOR_KEYBIND_CONFLICTS).toEqual([]);
  });

  it("flags two bindings that share a combo in the same context", () => {
    const dupes: EditorKeybind[] = [
      { id: "x", label: "X", category: "editing", keys: ["Mod+K"] },
      { id: "y", label: "Y", category: "tools", keys: ["Mod+K"] },
    ];
    const conflicts = findKeybindConflicts(dupes);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ids).toEqual(["x", "y"]);
  });

  it("allows the same combo across different contexts (layered, not a conflict)", () => {
    const layered: EditorKeybind[] = [
      { id: "a", label: "A", category: "editing", keys: ["Enter"] },
      {
        id: "b",
        label: "B",
        category: "text",
        keys: ["Enter"],
        context: "selection",
      },
    ];
    expect(findKeybindConflicts(layered)).toEqual([]);
  });
});

describe("resolveKeyDown (context + priority)", () => {
  it("matches a tool letter when the editor isn't typing", () => {
    expect(resolveKeyDown(ev({ key: "v", code: "KeyV" }), editor)?.id).toBe(
      "tool-select"
    );
    expect(resolveKeyDown(ev({ key: "t", code: "KeyT" }), editor)?.id).toBe(
      "tool-text"
    );
  });

  it("never fires tool letters while typing", () => {
    expect(resolveKeyDown(ev({ key: "v", code: "KeyV" }), typing)).toBeNull();
  });

  it("resolves Mod shortcuts (Ctrl or Cmd)", () => {
    expect(
      resolveKeyDown(ev({ key: "z", code: "KeyZ", ctrlKey: true }), editor)?.id
    ).toBe("undo");
    expect(
      resolveKeyDown(ev({ key: "z", code: "KeyZ", metaKey: true }), editor)?.id
    ).toBe("undo");
    expect(
      resolveKeyDown(
        ev({ key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true }),
        editor
      )?.id
    ).toBe("redo");
  });

  it("gates selection-context bindings on having a selection", () => {
    const del = ev({ key: "Delete", code: "Delete" });
    expect(resolveKeyDown(del, editor)).toBeNull();
    expect(resolveKeyDown(del, withSelection)?.id).toBe("delete");

    const right = ev({ key: "ArrowRight", code: "ArrowRight" });
    expect(resolveKeyDown(right, editor)).toBeNull();
    expect(resolveKeyDown(right, withSelection)?.id).toBe("nudge");
  });

  it("routes layer + resize combos by their full signature", () => {
    expect(
      resolveKeyDown(
        ev({ key: "]", code: "BracketRight", ctrlKey: true }),
        withSelection
      )?.id
    ).toBe("bring-forward");
    expect(
      resolveKeyDown(
        ev({ key: "]", code: "BracketRight", ctrlKey: true, shiftKey: true }),
        withSelection
      )?.id
    ).toBe("bring-front");
    expect(
      resolveKeyDown(
        ev({
          key: "ArrowRight",
          code: "ArrowRight",
          ctrlKey: true,
          shiftKey: true,
        }),
        withSelection
      )?.id
    ).toBe("resize-step");
  });
});

describe("resolveKeyUp", () => {
  it("matches the temporary-pan release", () => {
    expect(resolveKeyUp(ev({ key: " ", code: "Space" }), editor)?.id).toBe(
      "temp-pan"
    );
  });
});

describe("keybindGroups (help overlay source)", () => {
  it("orders tools first and omits hidden aliases", () => {
    const groups = keybindGroups();
    expect(groups[0]!.category).toBe("tools");
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain("duplicate");
    expect(ids).toContain("bring-forward");
    expect(ids).toContain("zoom-selection");
    // Hidden Illustrator-style aliases are not listed.
    expect(ids).not.toContain("bring-forward-alt");
  });
});

describe("paletteCommands (command-palette source)", () => {
  const ids = (st = { hasSelection: false }) =>
    paletteCommands(st).map((c) => c.kb.id);

  it("orders by category and includes ordinary commands", () => {
    const rows = paletteCommands({ hasSelection: false });
    expect(rows[0]!.kb.category).toBe("tools");
    expect(rows.map((c) => c.kb.id)).toEqual(
      expect.arrayContaining(["duplicate", "zoom-fit", "group", "save"])
    );
  });

  it("omits hidden aliases and keyboard-only bindings", () => {
    const listed = ids();
    // Alias of bring-forward — not a distinct command.
    expect(listed).not.toContain("bring-forward-alt");
    // Arrow-driven: direction lives in the event, so there is nothing to run.
    for (const id of [
      "nudge",
      "nudge-big",
      "resize-step",
      "resize-step-proportional",
    ]) {
      expect(listed).not.toContain(id);
    }
    // Held key: invoking it would latch pan on with no keyup to release it.
    expect(listed).not.toContain("temp-pan");
  });

  it("keeps selection-context commands, marked disabled with a reason", () => {
    const row = paletteCommands({ hasSelection: false }).find(
      (c) => c.kb.id === "delete"
    );
    expect(row).toBeDefined();
    expect(row!.enabled).toBe(false);
    expect(row!.disabledReason).toBe("Needs a selection");
  });

  it("enables selection-context commands once something is selected", () => {
    const row = paletteCommands({ hasSelection: true }).find(
      (c) => c.kb.id === "delete"
    );
    expect(row!.enabled).toBe(true);
    expect(row!.disabledReason).toBeUndefined();
  });

  it("stays available while the user types (the search box is a typing surface)", () => {
    // Regression guard for passing a live `typing: true` through to isActive,
    // which would empty the palette as soon as a query was entered.
    expect(ids()).toContain("select-all");
  });

  it("every listed command runs without a keyboard event", () => {
    // The palette invokes commands with `event: undefined`; none may assume one.
    for (const { kb } of paletteCommands({ hasSelection: true })) {
      expect(kb.onKeyDown).toBeDefined();
    }
  });
});
