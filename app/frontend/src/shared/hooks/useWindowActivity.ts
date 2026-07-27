/**
 * Reflects whether THIS window is "active" onto `<html data-idle>`.
 *
 * Every Clippity window is created at startup and kept alive for the
 * whole session (only hidden, never destroyed — see the backend's
 * `create_app_windows` + the `CloseRequested` hide-to-tray handler), so a
 * backgrounded window keeps its full render tree mounted. Anything that
 * keeps the compositor ticking — chiefly the infinite CSS keyframe
 * animations (the capture button's breathing ring, the overlay crosshair
 * pulse, the Tailwind `animate-*` spinners) — would otherwise burn GPU /
 * CPU while the user isn't even looking at the window. `theme.css` pauses
 * those animations under `[data-idle="true"]`; this hook owns the signal.
 *
 * A window is **idle** when it is NOT (focused AND document-visible):
 *   - hidden / minimized / fully occluded  → `document.visibilityState`
 *     flips to `hidden` (WebView2 maps OS occlusion onto page visibility),
 *   - unfocused but still visible (user alt-tabbed to another app but left
 *     Clippity on screen) → the window loses focus.
 *
 * Three signals are combined because none alone covers every window type:
 *   - Tauri `onFocusChanged` — authoritative OS focus from the window
 *     manager (the `blur`/`focus` DOM events aren't always delivered to a
 *     frameless, transparent webview),
 *   - `document.visibilitychange` — minimize / occlusion,
 *   - window `blur`/`focus` — DOM fallback for the browser-preview build
 *     where there is no Tauri window context.
 *
 * **Never-focused utility windows.** The toast and countdown windows are
 * created `focused: false` and never take focus, yet they ARE visible (and
 * animating) while shown. Treating "unfocused" as idle would wrongly
 * freeze their animations the entire time they're on screen. So blur only
 * marks a window idle once it has actually held focus at least once
 * (`everFocused`): a window that never gets focus is gated on visibility
 * alone, while focus-bearing windows (capture / main) still pause the
 * instant the user switches away.
 */

import { useEffect } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { isTauriContext } from "@services/tauri";

/** Write `data-idle` only on change so we don't churn the attribute (and
 *  trigger needless style recalcs) on every redundant event. */
function setIdle(idle: boolean): void {
  const root = document.documentElement;
  const next = idle ? "true" : "false";
  if (root.dataset.idle !== next) root.dataset.idle = next;
}

export function useWindowActivity(): void {
  useEffect(() => {
    if (typeof document === "undefined") return;

    // Seed from the live focus state so the startup foreground window
    // (capture) begins active and a window that opened in the background
    // begins idle. `hasFocus()` is the closest synchronous truth we have
    // before the first event arrives.
    let focused = document.hasFocus();
    let everFocused = focused;

    const apply = () => {
      const visible = document.visibilityState !== "hidden";
      // A window that has never held focus (toast / countdown) is judged
      // on visibility alone — it's allowed to animate while shown even
      // though it's unfocused by design.
      const idle = everFocused ? !(focused && visible) : !visible;
      setIdle(idle);
    };

    const onFocus = () => {
      focused = true;
      everFocused = true;
      apply();
    };
    const onBlur = () => {
      focused = false;
      apply();
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", apply);
    apply();

    // Authoritative OS focus via Tauri — the DOM `blur`/`focus` events
    // above aren't reliably delivered to a frameless transparent webview.
    // Guarded on the Tauri context because `getCurrentWindow()` throws
    // synchronously in the plain-browser preview / test build, where the
    // DOM events are the only signal anyway.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    if (isTauriContext()) {
      getCurrentWindow()
        .onFocusChanged(({ payload: isFocused }) => {
          focused = isFocused;
          if (isFocused) everFocused = true;
          apply();
        })
        .then((u) => {
          if (cancelled) u();
          else unlisten = u;
        })
        .catch(() => {
          /* listener failed to register — DOM events remain the fallback */
        });
    }

    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", apply);
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
