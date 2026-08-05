/**
 * In-app quick-capture shortcuts for the Home view.
 *
 * Binds a single `keydown` listener while the Home view is mounted, so
 * the capture shortcuts (`Ctrl/⌘ + 1` Screenshot, `Ctrl/⌘ + 2` Window)
 * are live exactly when Home is on screen — and nowhere else. That scope
 * matters: the editor binds `Mod+1` / `Mod+G` to its own commands, so an
 * app-wide capture hotkey would collide. Home only mounts on the `home`
 * dashboard view, so mounting the listener here is the scoping.
 *
 * Matching goes through the shared keybind signature primitives
 * (`eventSigKey` vs. `comboSigKey`) — the same layout-stable, Ctrl⇄Cmd
 * unified matcher the editor and library use — built from the action
 * table's own combos, so the chip a card shows and the key that fires it
 * are guaranteed to be the same binding. Only `available` actions with a
 * combo are registered; typing surfaces (inputs, textareas) are skipped.
 *
 * These are window-focused shortcuts, not OS-global accelerators —
 * system-wide capture hotkeys would need a backend global-shortcut
 * registration (the "Shortcuts" settings section is still to come).
 */

import { useEffect } from "react";

import {
  comboSigKey,
  eventSigKey,
  isTypingTarget,
} from "@features/editor/keybinds/keybindUtils";
import { effectiveKeys, getKeybindOverrides } from "@shared/keybinds/overrides";
import { useKeybindOverridesVersion } from "@shared/keybinds/useKeybindOverrides";

import { useCapabilities } from "@state/useCapabilities";

import {
  QUICK_CAPTURE_ACTIONS,
  unavailabilityOf,
  type QuickCaptureId,
} from "../lib/quickCapture";

export function useQuickCaptureHotkeys(
  dispatch: (id: QuickCaptureId) => void
): void {
  // A key must not fire an action whose card is disabled — including one
  // disabled because the component was declined at install time.
  const capabilities = useCapabilities();
  // Rebuild the listener when the user remaps a quick-capture key. Unlike
  // the editor/library dispatch (which resolves lazily), this hook holds a
  // prebuilt signature map, so it must re-run on an override change.
  const overridesVersion = useKeybindOverridesVersion();

  useEffect(() => {
    // Signature → action id, built from each available action's *effective*
    // combos (user override if present, else the default `combo`).
    const overrides = getKeybindOverrides();
    const bindings = new Map<string, QuickCaptureId>();
    for (const action of QUICK_CAPTURE_ACTIONS) {
      if (unavailabilityOf(action, capabilities)) continue;
      const defaults = action.combo ? [action.combo] : [];
      for (const combo of effectiveKeys(
        "quickCapture",
        action.id,
        defaults,
        overrides
      )) {
        bindings.set(comboSigKey(combo), action.id);
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || isTypingTarget(e.target)) return;
      const id = bindings.get(eventSigKey(e));
      if (!id) return;
      e.preventDefault();
      dispatch(id);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [capabilities, dispatch, overridesVersion]);
}
