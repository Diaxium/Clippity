/**
 * Library keybind system — public surface. See `docs/library-keybinds.md`.
 */

export { useLibraryKeybinds } from "./useLibraryKeybinds";
export {
  LIBRARY_KEYBINDS,
  findLibraryKeybindConflicts,
  resolveLibraryKeyDown,
  type LibraryKeybind,
  type LibraryKeybindApi,
  type LibraryKeybindContext,
  type LibraryDispatchState,
} from "./libraryKeybinds";
