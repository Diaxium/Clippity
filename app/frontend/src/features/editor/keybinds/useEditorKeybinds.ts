/**
 * The editor's single keyboard entry point. Installs one window `keydown` /
 * `keyup` / `blur` listener set and routes events through {@link resolveKeyDown}
 * / {@link resolveKeyUp} so exactly one command runs per event. Owns the
 * history coalescing for held nudge/resize bursts (one undo step per burst) and
 * tears down the temporary-pan flag on blur.
 *
 * Everything else (tool gestures, pen Esc/Enter, wheel zoom) stays in the
 * canvas; this hook never re-implements pointer logic. Pen Esc/Enter run in a
 * capture-phase canvas listener that stops propagation while a path is open, so
 * they never reach this bubble-phase listener.
 */

import { useEffect, useRef } from "react";

import { useEditorStore } from "../state/editorStore";
import type { CommandCtx, KeybindApi } from "./keybindTypes";
import {
  resolveKeyDown,
  resolveKeyUp,
  type DispatchState,
} from "./keybindRegistry";
import { isTypingTarget } from "./keybindUtils";

/** Idle gap (ms) after the last nudge/resize keystroke before the coalesced
 *  history transaction is committed. */
const COALESCE_IDLE_MS = 450;

/** Bindings allowed to fire while the help overlay is open. */
const HELP_ALLOWED = new Set(["escape", "help"]);

function dispatchState(e: KeyboardEvent): DispatchState {
  const s = useEditorStore.getState();
  return {
    typing: isTypingTarget(e.target) || isTypingTarget(document.activeElement),
    hasSelection: s.selectedIds.length > 0,
    editingText: s.editingTextId !== null,
  };
}

/**
 * @param enabled  Bind only while the editor owns a document (false for the
 *                 empty state) so global keys aren't hijacked.
 * @param api      React-bound side effects (export / clipboard / help toggle).
 */
export function useEditorKeybinds(enabled: boolean, api: KeybindApi): void {
  // Hold the latest api without re-subscribing the window listener each render
  // (exportPng/copyPng identities change with the export hook's `busy` flag).
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    if (!enabled) return;

    // One coalesced history transaction spanning a burst of nudges/resizes.
    const nudge: { open: boolean; timer: number | null } = {
      open: false,
      timer: null,
    };
    const flushNudge = () => {
      if (nudge.timer !== null) {
        clearTimeout(nudge.timer);
        nudge.timer = null;
      }
      if (nudge.open) {
        useEditorStore.getState().endHistory();
        nudge.open = false;
      }
    };
    const touchNudge = () => {
      if (!nudge.open) {
        useEditorStore.getState().beginHistory();
        nudge.open = true;
      }
      if (nudge.timer !== null) clearTimeout(nudge.timer);
      nudge.timer = window.setTimeout(flushNudge, COALESCE_IDLE_MS);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const st = dispatchState(e);
      const kb = resolveKeyDown(e, st);
      if (!kb) return;
      // While help is open, only Esc (close) and ? (toggle) are live.
      if (useEditorStore.getState().helpOpen && !HELP_ALLOWED.has(kb.id))
        return;

      if (kb.coalesce) touchNudge();
      else flushNudge(); // a non-nudge action commits any open nudge burst first

      const ctx: CommandCtx = {
        store: useEditorStore.getState(),
        event: e,
        api: apiRef.current,
      };
      kb.onKeyDown?.(ctx);
      if (kb.preventDefault !== false) e.preventDefault();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const kb = resolveKeyUp(e, dispatchState(e));
      if (!kb) return;
      const ctx: CommandCtx = {
        store: useEditorStore.getState(),
        event: e,
        api: apiRef.current,
      };
      kb.onKeyUp?.(ctx);
      if (kb.preventDefault !== false) e.preventDefault();
    };

    // Losing focus (Alt-Tab while holding Space) must release temp-pan and
    // commit any pending nudge transaction so state never sticks.
    const onBlur = () => {
      flushNudge();
      useEditorStore.getState().setTempPan(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      flushNudge();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled]);
}
