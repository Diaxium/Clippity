/**
 * The library's single window-level key handler.
 *
 * Mounted once by `LibraryLayout`, mirroring how `EditorLayout` mounts
 * `useEditorKeybinds` — one listener that resolves an event to at most
 * one command, rather than a keydown effect per component. The two views
 * are never mounted at the same time (the dashboard renders one), so
 * their `Mod+A` bindings can't both fire.
 *
 * State is read through `getState()` at event time instead of being
 * subscribed to, so the listener is attached once and never re-bound as
 * the selection changes — a fresh listener on every selection change
 * would be a lot of churn for a value only read when a key is pressed.
 */

import { useEffect } from "react";

import { useLibraryStore } from "../state/libraryStore";
import {
  isTypingTarget,
  resolveLibraryKeyDown,
  type LibraryKeybindApi,
} from "./libraryKeybinds";

export function useLibraryKeybinds(enabled: boolean, api: LibraryKeybindApi) {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const store = useLibraryStore.getState();
      const kb = resolveLibraryKeyDown(e, {
        // Typing protection: the search box, the tag editor and the
        // rename fields all live inside this window, and `Mod+A` there
        // means "select this text".
        typing: isTypingTarget(e.target),
        hasSelection: store.selected.length > 0,
      });
      if (!kb) return;
      if (kb.preventDefault !== false) e.preventDefault();
      kb.onKeyDown({ store, event: e, api });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, api]);
}
