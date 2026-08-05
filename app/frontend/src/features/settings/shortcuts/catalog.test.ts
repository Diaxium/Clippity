import { describe, expect, it } from "vitest";

import { EDITOR_KEYBINDS } from "@features/editor/keybinds";
import { QUICK_CAPTURE_ACTIONS } from "@features/home/lib/quickCapture";

import {
  entryKeys,
  findShortcutConflicts,
  isEntryOverridden,
  SHORTCUT_ENTRIES,
  SHORTCUT_GROUPS,
} from "./catalog";

describe("SHORTCUT_GROUPS / SHORTCUT_ENTRIES", () => {
  it("has capture, library, and editor groups with entries", () => {
    const labels = SHORTCUT_GROUPS.map((g) => g.label);
    expect(labels).toContain("Capture");
    expect(labels).toContain("Library");
    expect(labels.some((l) => l.startsWith("Editor · "))).toBe(true);
    expect(SHORTCUT_ENTRIES.length).toBeGreaterThan(0);
  });

  it("excludes hidden and paletteHidden editor bindings", () => {
    const excluded = EDITOR_KEYBINDS.filter(
      (kb) => kb.hidden || kb.paletteHidden
    ).map((kb) => `editor:${kb.id}`);
    const present = new Set(SHORTCUT_ENTRIES.map((e) => e.fqid));
    for (const fqid of excluded) {
      expect(present.has(fqid)).toBe(false);
    }
    // A concrete example: the arrow-driven nudge family is keyboard-only.
    expect(present.has("editor:nudge")).toBe(false);
    // …while a plain rebindable action is present.
    expect(present.has("editor:undo")).toBe(true);
  });

  it("only surfaces available quick-capture actions", () => {
    // Derived from the launcher definitions rather than a hardcoded
    // list: which actions are available changes as pipelines land (the
    // recorder added Record and GIF), and the rule under test is the
    // filter, not today's answer. A rebindable shortcut for an action
    // with no backend would be a customizable no-op.
    const captureIds = SHORTCUT_ENTRIES.filter(
      (e) => e.scope === "quickCapture"
    ).map((e) => e.id);
    const expected = QUICK_CAPTURE_ACTIONS.filter((a) => a.available).map(
      (a) => a.id
    );
    expect(new Set(captureIds)).toEqual(new Set(expected));
    expect(captureIds).toContain("screenshot");
  });
});

describe("entryKeys / isEntryOverridden", () => {
  const undo = SHORTCUT_ENTRIES.find((e) => e.fqid === "editor:undo")!;

  it("returns the registry default with no override", () => {
    expect(entryKeys(undo, {})).toEqual(undo.defaultKeys);
    expect(isEntryOverridden(undo, {})).toBe(false);
  });

  it("returns the override and flags the entry as customized", () => {
    const overrides = { "editor:undo": ["Mod+Shift+U"] };
    expect(entryKeys(undo, overrides)).toEqual(["Mod+Shift+U"]);
    expect(isEntryOverridden(undo, overrides)).toBe(true);
  });

  it("flags an explicit unbind as customized", () => {
    expect(isEntryOverridden(undo, { "editor:undo": [] })).toBe(true);
  });
});

describe("findShortcutConflicts", () => {
  it("is empty for the shipped defaults", () => {
    expect(findShortcutConflicts({}).size).toBe(0);
  });

  it("flags two bindings sharing a key in the same scope + context", () => {
    // `undo` (context editor) remapped onto `select-all`'s Mod+A (also editor).
    const conflicts = findShortcutConflicts({ "editor:undo": ["Mod+A"] });
    expect(conflicts.has("editor:undo")).toBe(true);
    expect(conflicts.has("editor:select-all")).toBe(true);
  });

  it("does not flag a shared key across different contexts", () => {
    // `duplicate` is selection-context; sharing Mod+A with the editor-context
    // `select-all` is intentional layering, not a conflict.
    const conflicts = findShortcutConflicts({ "editor:duplicate": ["Mod+A"] });
    expect(conflicts.has("editor:duplicate")).toBe(false);
    expect(conflicts.has("editor:select-all")).toBe(false);
  });

  it("does not flag a shared key across different scopes", () => {
    // Editor and library both bind Mod+A to select-all by default; they are
    // never mounted together, so that is not a conflict.
    expect(findShortcutConflicts({}).has("library:select-all")).toBe(false);
  });
});
