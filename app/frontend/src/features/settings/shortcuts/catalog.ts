/**
 * Shortcuts settings catalog — the single, flat enumeration of every
 * *customizable* in-app binding, assembled from the three keybind
 * registries (editor / library / quick-capture) that own the real
 * defaults. The Settings panel renders from this; nothing here re-declares
 * a binding, so the catalog can't drift from what the app actually does.
 *
 * "Customizable" deliberately excludes the keyboard-only families that
 * don't map to a single rebindable combo:
 *  - `hidden` editor aliases (not distinct commands),
 *  - `paletteHidden` editor bindings (the arrow-driven nudge/resize
 *    families and the held-key temp-pan — multi-combo or press-and-hold),
 *  - the unavailable quick-capture cards (Record / GIF — no backend yet).
 *
 * Each entry carries its `context` so conflict detection can scope
 * correctly: two bindings clash only when they share a scope *and* an
 * active context (an editor tool letter and a selection-only action may
 * reuse a key on purpose — dispatch layers them by priority).
 */

import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  comboSigKey,
  EDITOR_KEYBINDS,
} from "@features/editor/keybinds";
import { LIBRARY_KEYBINDS } from "@features/library/keybinds";
import { QUICK_CAPTURE_ACTIONS } from "@features/home/lib/quickCapture";
import {
  effectiveKeys,
  fqid,
  type KeybindOverrides,
  type KeybindScope,
} from "@shared/keybinds/overrides";

/** One rebindable action in the catalog. */
export interface ShortcutEntry {
  /** `"<scope>:<id>"` — the overrides map key. */
  fqid: string;
  scope: KeybindScope;
  id: string;
  label: string;
  /** Conflict scope within a registry. Bindings clash only within the
   *  same `scope` + `context`. */
  context: string;
  /** Registry default combos (what "Reset" restores). */
  defaultKeys: string[];
}

/** A titled block of entries in the panel (mirrors the registry sections). */
export interface ShortcutGroup {
  key: string;
  label: string;
  entries: ShortcutEntry[];
}

/** Editor groups, one per keybind category, in the help-overlay order. */
function editorGroups(): ShortcutGroup[] {
  const groups: ShortcutGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const entries = EDITOR_KEYBINDS.filter(
      (kb) => kb.category === category && !kb.hidden && !kb.paletteHidden,
    ).map<ShortcutEntry>((kb) => ({
      fqid: fqid("editor", kb.id),
      scope: "editor",
      id: kb.id,
      label: kb.label,
      context: kb.context ?? "editor",
      defaultKeys: [...kb.keys],
    }));
    if (entries.length > 0) {
      groups.push({
        key: `editor:${category}`,
        label: `Editor · ${CATEGORY_LABEL[category]}`,
        entries,
      });
    }
  }
  return groups;
}

function libraryGroup(): ShortcutGroup {
  return {
    key: "library",
    label: "Library",
    entries: LIBRARY_KEYBINDS.map((kb) => ({
      fqid: fqid("library", kb.id),
      scope: "library",
      id: kb.id,
      label: kb.label,
      context: kb.context ?? "library",
      defaultKeys: [...kb.keys],
    })),
  };
}

function captureGroup(): ShortcutGroup {
  return {
    key: "quickCapture",
    label: "Capture",
    entries: QUICK_CAPTURE_ACTIONS.filter((a) => a.available && a.combo).map(
      (a) => ({
        fqid: fqid("quickCapture", a.id),
        scope: "quickCapture" as const,
        id: a.id,
        label: a.title,
        context: "quickCapture",
        defaultKeys: a.combo ? [a.combo] : [],
      }),
    ),
  };
}

/**
 * The full catalog, Capture first (the everyday actions), then Library,
 * then the editor's many categories. Computed once — the registries are
 * static module data.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  captureGroup(),
  libraryGroup(),
  ...editorGroups(),
].filter((g) => g.entries.length > 0);

/** Flat view of every catalog entry (conflict scan, reset-all). */
export const SHORTCUT_ENTRIES: readonly ShortcutEntry[] = SHORTCUT_GROUPS.flatMap(
  (g) => g.entries,
);

/** An entry's effective combos given the current overrides map. */
export function entryKeys(
  entry: ShortcutEntry,
  overrides: KeybindOverrides,
): string[] {
  return effectiveKeys(entry.scope, entry.id, entry.defaultKeys, overrides);
}

/** Is this entry currently remapped away from its registry default? */
export function isEntryOverridden(
  entry: ShortcutEntry,
  overrides: KeybindOverrides,
): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, entry.fqid);
}

/**
 * The set of `fqid`s whose current binding collides with another entry in
 * the same scope + context. A combo bucket with two or more distinct
 * entries is a real ambiguity — the dispatch would fire only the
 * higher-priority one, silently shadowing the other.
 */
export function findShortcutConflicts(
  overrides: KeybindOverrides,
): Set<string> {
  const buckets = new Map<string, Set<string>>();
  for (const entry of SHORTCUT_ENTRIES) {
    for (const combo of entryKeys(entry, overrides)) {
      const bucketKey = `${entry.scope}|${entry.context}|${comboSigKey(combo)}`;
      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = new Set();
        buckets.set(bucketKey, bucket);
      }
      bucket.add(entry.fqid);
    }
  }
  const conflicted = new Set<string>();
  for (const bucket of buckets.values()) {
    if (bucket.size > 1) {
      for (const id of bucket) conflicted.add(id);
    }
  }
  return conflicted;
}
