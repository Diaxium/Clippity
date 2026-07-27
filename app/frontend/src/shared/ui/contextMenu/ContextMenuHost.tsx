import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@shared/lib/cn";

import { useContextMenuStore } from "./contextMenuStore";
import type { ContextMenuAction, ContextMenuEntry } from "./types";

/** Keep-off-the-edge gutter, and the width assumed for the first
 *  (pre-measurement) layout pass. */
const MARGIN = 8;
const ASSUMED_W = 200;

function isAction(entry: ContextMenuEntry): entry is ContextMenuAction {
  return entry !== "divider";
}

/**
 * The app-wide right-click menu — one host per window, mounted by
 * `Providers`, fed by `useContextMenu` regions and by the global
 * fallback in `useNativeContextMenu`.
 *
 * The editor keeps its own menu (`EditorContextMenu`): it is painted in
 * the editor's `--ed-*` palette rather than the app's, and its entries
 * come straight off the editor store. The two never overlap because the
 * editor's triggers stop propagation before the global fallback sees the
 * event.
 *
 * Placement is measure-then-clamp: the panel renders hidden at the click
 * point for one frame, gets measured, and is then flipped/clamped into
 * the viewport. That costs a frame but is the only way to know the
 * height of a list whose length varies per surface.
 */
export function ContextMenuHost() {
  const menu = useContextMenuStore((s) => s.menu);
  const close = useContextMenuStore((s) => s.close);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);

  // Fresh menu → drop the previous placement so the panel stays hidden
  // until it has been measured where it now sits.
  useLayoutEffect(() => {
    if (!menu) {
      setPos(null);
      setActive(-1);
      return;
    }
    const rect = ref.current?.getBoundingClientRect();
    const w = rect?.width || ASSUMED_W;
    const h = rect?.height ?? 0;
    setPos({
      left: Math.max(MARGIN, Math.min(menu.x, window.innerWidth - w - MARGIN)),
      top: Math.max(MARGIN, Math.min(menu.y, window.innerHeight - h - MARGIN)),
    });
    setActive(-1);
  }, [menu]);

  const run = useCallback(
    (entry: ContextMenuAction) => {
      if (entry.disabled) return;
      // Close first: an entry that opens a dialog or moves focus should
      // not have to fight a menu that is still on screen.
      close();
      entry.onSelect();
    },
    [close]
  );

  useEffect(() => {
    if (!menu) return;
    const step = (dir: 1 | -1) => {
      setActive((current) => {
        const n = menu.entries.length;
        // Nothing highlighted yet: ArrowDown starts at the top,
        // ArrowUp at the bottom.
        const from = current < 0 ? (dir === 1 ? -1 : 0) : current;
        for (let i = 1; i <= n; i += 1) {
          const next = (((from + dir * i) % n) + n) % n;
          const entry = menu.entries[next];
          if (entry && isAction(entry) && !entry.disabled) return next;
        }
        return current;
      });
    };

    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "ArrowDown":
          e.preventDefault();
          step(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          step(-1);
          break;
        case "Enter":
        case " ": {
          const entry = menu.entries[active];
          if (entry && isAction(entry)) {
            e.preventDefault();
            run(entry);
          }
          break;
        }
        // Any other key dismisses and is then left entirely alone.
        //
        // Not swallowed: the menu is frequently opened over a text field,
        // and eating the keystroke would mean right-clicking an input and
        // then typing does nothing at all, with no hint as to why. Typing
        // means "I'm done with the menu", so the character has to reach
        // the field it was aimed at. Bare modifiers are not a keystroke
        // yet — Shift on its own must not close a menu the user is about
        // to Shift-click in.
        case "Shift":
        case "Control":
        case "Alt":
        case "Meta":
          break;
        default:
          close();
          break;
      }
    };

    // Capture phase: feature keymaps (e.g. the editor's) listen on window
    // too, and Escape must close the menu rather than clear a selection.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    // Capture, because the scroll that matters happens in an inner pane
    // (the capture grid, the layers list) and doesn't bubble.
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu, active, close, run]);

  if (!menu) return null;

  return createPortal(
    <>
      {/* Full-screen catcher: any press outside dismisses, and a second
          right-click is handled here so it doesn't reopen the same menu
          underneath itself. */}
      <div
        className="no-drag fixed inset-0 z-[70]"
        onPointerDown={close}
        onContextMenu={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={menu.label ?? "Context menu"}
        style={{
          position: "fixed",
          left: pos?.left ?? menu.x,
          top: pos?.top ?? menu.y,
          visibility: pos ? "visible" : "hidden",
        }}
        className="no-drag z-[71] min-w-[196px] rounded-[11px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-1.5 shadow-[var(--shadow-medium)]"
      >
        {menu.entries.map((entry, i) =>
          entry === "divider" ? (
            <div
              key={`divider-${i}`}
              role="separator"
              className="my-1 h-px bg-[color:var(--hairline)]"
            />
          ) : (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              aria-disabled={entry.disabled}
              onPointerEnter={() => !entry.disabled && setActive(i)}
              onClick={() => run(entry)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] transition-colors",
                entry.disabled
                  ? "cursor-default text-[color:var(--color-slate)] opacity-45"
                  : entry.danger
                    ? "text-[var(--ed-danger,#f24822)] hover:bg-[color:var(--color-overlay-1)]"
                    : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]",
                active === i &&
                  !entry.disabled &&
                  "bg-[color:var(--color-overlay-1)]"
              )}
            >
              {entry.icon && <entry.icon size={14} strokeWidth={1.85} />}
              <span className="flex-1">{entry.label}</span>
              {entry.shortcut && (
                <span className="text-[11px] text-[color:var(--color-slate)] opacity-70">
                  {entry.shortcut}
                </span>
              )}
            </button>
          )
        )}
      </div>
    </>,
    document.body
  );
}
