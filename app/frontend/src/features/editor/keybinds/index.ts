/**
 * Editor keybind system — public surface.
 *
 * `useEditorKeybinds` is the single window-level handler (mounted by
 * `EditorLayout`). The registry data + helpers are exported for the help
 * overlay and tests. See `docs/editor-keybinds.md`.
 */

export { useEditorKeybinds } from "./useEditorKeybinds";
export { EDITOR_KEYBINDS } from "./editorKeybinds";
export {
  keybindGroups,
  paletteCommands,
  resolveKeyDown,
  resolveKeyUp,
  EDITOR_KEYBIND_CONFLICTS,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  type KeybindGroup,
  type DispatchState,
  type PaletteCommand,
  type PaletteState,
} from "./keybindRegistry";
export {
  formatCombo,
  comboFromEvent,
  comboSigKey,
  findKeybindConflicts,
  isTypingTarget,
  IS_MAC,
  parseCombo,
  sigFromEvent,
  type KeySig,
  type KeybindConflict,
} from "./keybindUtils";
export type {
  EditorKeybind,
  KeybindApi,
  KeybindCategory,
  KeybindContext,
  CommandCtx,
  EditorCommand,
} from "./keybindTypes";
