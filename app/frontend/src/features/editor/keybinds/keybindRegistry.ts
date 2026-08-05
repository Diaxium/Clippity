/**
 * Dispatch index over {@link EDITOR_KEYBINDS}. Resolves a key event to at most
 * one binding by signature + active context, so a single event never fires two
 * commands. Also runs conflict detection once at load (dev warning) and exposes
 * the by-category grouping the help overlay renders.
 *
 * Context priority (highest wins): textEditing > selection > editor. A key may
 * appear in two contexts on purpose (e.g. an editor default plus a
 * selection-only override); the most specific *active* one is chosen.
 */

import {
  fqid,
  getKeybindOverrides,
  keybindOverridesVersion,
} from "@shared/keybinds/overrides";

import { EDITOR_KEYBINDS } from "./editorKeybinds";
import type {
  EditorKeybind,
  KeybindCategory,
  KeybindContext,
} from "./keybindTypes";
import {
  comboSigKey,
  eventSigKey,
  findKeybindConflicts,
  type KeybindConflict,
} from "./keybindUtils";

/**
 * The default map with user overrides applied — the list every dispatch,
 * help-overlay, and palette read goes through. An overridden binding gets
 * its `keys` replaced and its hand-authored `helpKeys` cleared, so the
 * help chips regenerate from the new combo instead of showing the stale
 * default. Bindings without an override pass through by reference.
 */
export function effectiveEditorKeybinds(): readonly EditorKeybind[] {
  ensureEffective();
  return effectiveList;
}

/** Scope tag for the editor's fully-qualified override ids. */
const SCOPE = "editor" as const;

// Memoized on the override version so a burst of dispatches doesn't rebuild
// the list/indices per keystroke — only when the user actually remaps a key.
let cachedVersion = -1;
let effectiveList: readonly EditorKeybind[] = EDITOR_KEYBINDS;
let keydownIndex = new Map<string, EditorKeybind[]>();
let keyupIndex = new Map<string, EditorKeybind[]>();

function ensureEffective(): void {
  const version = keybindOverridesVersion();
  if (version === cachedVersion && cachedVersion !== -1) return;
  const overrides = getKeybindOverrides();
  effectiveList = EDITOR_KEYBINDS.map((kb) => {
    const override = overrides[fqid(SCOPE, kb.id)];
    if (override === undefined) return kb;
    return { ...kb, keys: override, helpKeys: undefined };
  });
  keydownIndex = buildIndex(effectiveList, (kb) => !!kb.onKeyDown);
  keyupIndex = buildIndex(effectiveList, (kb) => !!kb.onKeyUp);
  cachedVersion = version;
}

const CONTEXT_PRIORITY: Record<KeybindContext, number> = {
  textEditing: 3,
  selection: 2,
  editor: 1,
};

/** Runtime gating snapshot, derived from the store by the hook. */
export interface DispatchState {
  /** Active element is a typing surface (input/textarea/contenteditable). */
  typing: boolean;
  /** ≥1 node selected. */
  hasSelection: boolean;
  /** The inline text editor is open. */
  editingText: boolean;
}

function contextOf(kb: EditorKeybind): KeybindContext {
  return kb.context ?? "editor";
}

/** Is this binding live given the current gating snapshot? */
export function isActive(kb: EditorKeybind, st: DispatchState): boolean {
  const ctx = contextOf(kb);
  if (ctx === "textEditing") return st.editingText;
  if (st.typing && !kb.allowWhileTyping) return false;
  if (ctx === "selection") return st.hasSelection;
  return true;
}

function buildIndex(
  list: readonly EditorKeybind[],
  pick: (kb: EditorKeybind) => boolean
): Map<string, EditorKeybind[]> {
  const index = new Map<string, EditorKeybind[]>();
  for (const kb of list) {
    if (!pick(kb)) continue;
    for (const combo of kb.keys) {
      const sig = comboSigKey(combo);
      const bucket = index.get(sig);
      if (bucket) bucket.push(kb);
      else index.set(sig, [kb]);
    }
  }
  return index;
}

/** Highest-priority active binding among candidates, or null. */
function resolve(
  index: Map<string, EditorKeybind[]>,
  e: KeyboardEvent,
  st: DispatchState
): EditorKeybind | null {
  const candidates = index.get(eventSigKey(e));
  if (!candidates) return null;
  let best: EditorKeybind | null = null;
  let bestPriority = -1;
  for (const kb of candidates) {
    if (!isActive(kb, st)) continue;
    const priority = CONTEXT_PRIORITY[contextOf(kb)];
    if (priority > bestPriority) {
      best = kb;
      bestPriority = priority;
    }
  }
  return best;
}

export function resolveKeyDown(
  e: KeyboardEvent,
  st: DispatchState
): EditorKeybind | null {
  ensureEffective();
  return resolve(keydownIndex, e, st);
}

export function resolveKeyUp(
  e: KeyboardEvent,
  st: DispatchState
): EditorKeybind | null {
  ensureEffective();
  return resolve(keyupIndex, e, st);
}

/** Display order for the help overlay. */
export const CATEGORY_ORDER: readonly KeybindCategory[] = [
  "tools",
  "selection",
  "editing",
  "layers",
  "view",
  "transform",
  "text",
  "file",
];

export const CATEGORY_LABEL: Record<KeybindCategory, string> = {
  tools: "Tools",
  selection: "Selection",
  editing: "Editing",
  layers: "Layers",
  view: "View",
  transform: "Transform / Resize",
  text: "Text",
  file: "File / Export",
};

export interface KeybindGroup {
  category: KeybindCategory;
  label: string;
  items: EditorKeybind[];
}

/** Non-hidden bindings grouped by category in display order (empty groups
 *  dropped). Powers the help overlay. */
export function keybindGroups(): KeybindGroup[] {
  const list = effectiveEditorKeybinds();
  const groups: KeybindGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const items = list.filter((kb) => kb.category === category && !kb.hidden);
    if (items.length > 0) {
      groups.push({ category, label: CATEGORY_LABEL[category], items });
    }
  }
  return groups;
}

/** Runtime gating the command palette can actually observe. Unlike
 *  {@link DispatchState} there is no `typing` flag: the palette's own search box
 *  *is* a typing surface, so feeding the live value through would gate off
 *  nearly every command the moment the user types a query. */
export interface PaletteState {
  hasSelection: boolean;
}

/** A palette row: the binding plus whether it can run right now. Unavailable
 *  commands are returned (not filtered) so the palette can show them disabled —
 *  in an editor this deep, "exists but needs a selection" teaches the model,
 *  while hiding the row just reads as a broken search. */
export interface PaletteCommand {
  kb: EditorKeybind;
  enabled: boolean;
  /** Set when `enabled` is false — a short reason for the UI. */
  disabledReason?: string;
}

/**
 * Registry bindings that make sense as palette entries, in {@link
 * CATEGORY_ORDER}. Excludes `hidden` aliases (not distinct commands) and
 * `paletteHidden` bindings (keyboard-only: arrow-driven or held-key).
 *
 * Availability reuses {@link isActive} so the palette and the keyboard agree on
 * one definition. `textEditing`-context bindings resolve to unavailable, which
 * is correct: the inline text editor cannot be focused while the palette is.
 */
export function paletteCommands(st: PaletteState): PaletteCommand[] {
  const dispatch: DispatchState = {
    typing: false,
    hasSelection: st.hasSelection,
    editingText: false,
  };
  const list = effectiveEditorKeybinds();
  const rows: PaletteCommand[] = [];
  for (const category of CATEGORY_ORDER) {
    for (const kb of list) {
      if (kb.category !== category) continue;
      if (kb.hidden || kb.paletteHidden) continue;
      if (!kb.onKeyDown) continue; // keyup-only has nothing to invoke
      const enabled = isActive(kb, dispatch);
      rows.push(
        enabled
          ? { kb, enabled }
          : { kb, enabled, disabledReason: disabledReasonFor(kb) }
      );
    }
  }
  return rows;
}

function disabledReasonFor(kb: EditorKeybind): string {
  return contextOf(kb) === "selection"
    ? "Needs a selection"
    : "Not available right now";
}

/** Same-context duplicate signatures (should always be empty). */
export const EDITOR_KEYBIND_CONFLICTS: KeybindConflict[] =
  findKeybindConflicts(EDITOR_KEYBINDS);

// Surface accidental duplicates during development without crashing the app.
if (import.meta.env?.DEV && EDITOR_KEYBIND_CONFLICTS.length > 0) {
  for (const c of EDITOR_KEYBIND_CONFLICTS) {
    console.warn(
      `[editor keybinds] conflict in "${c.context}" context (${c.sig}): ${c.ids.join(", ")}`
    );
  }
}
