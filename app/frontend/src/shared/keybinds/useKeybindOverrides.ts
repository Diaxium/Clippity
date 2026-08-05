/**
 * React binding for the module-level keybind-override store. Components
 * that build their listeners from override-derived data (e.g. the
 * quick-capture hotkeys, the Shortcuts settings panel) subscribe to the
 * version counter so they re-run when the user remaps a key.
 *
 * The editor and library keybind hooks deliberately do NOT use this — their
 * dispatch reads the memoized index lazily at keypress time, so a remap
 * takes effect on the next keystroke without re-subscribing the window
 * listener. This hook is for the surfaces that must rebuild eagerly.
 */

import { useSyncExternalStore } from "react";

import {
  keybindOverridesVersion,
  subscribeKeybindOverrides,
} from "./overrides";

/** The current override version — changes whenever overrides are replaced. */
export function useKeybindOverridesVersion(): number {
  return useSyncExternalStore(
    subscribeKeybindOverrides,
    keybindOverridesVersion,
    keybindOverridesVersion
  );
}
