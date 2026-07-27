import { useEffect } from "react";

import { fallbackEntries } from "./fallbackEntries";
import { openContextMenu, useContextMenuStore } from "./contextMenuStore";

/**
 * Kills the WebView2 context menu app-wide and routes right-clicks that
 * no feature claimed into the shared menu.
 *
 * Mounted once per window by `Providers`, so all six Tauri windows
 * (main, capture, countdown, overlay, toast, tray) are covered by the one
 * call — they all boot the same bundle through `App`.
 *
 * Two listeners, and the split is the whole design:
 *
 *  - **Capture phase, on `document`.** Runs before anything else can see
 *    the event and unconditionally calls `preventDefault()`. Suppression
 *    is therefore not something each surface has to remember: a region
 *    that forgets, or a component that throws mid-handler, still cannot
 *    leak the "Reload / Save image as… / Inspect" popup into a desktop
 *    app. Nothing here inspects the target, so there is no way for it to
 *    decide *not* to suppress.
 *  - **Bubble phase, on `document`.** Only reached when no region called
 *    `stopPropagation` — which `useContextMenu` does for every menu it
 *    opens. So arriving here means "nobody claimed this click", and the
 *    target-aware fallback (`fallbackEntries`) gets to answer.
 *
 * The editor's own menu opts out of the fallback the same way: its canvas
 * and layer-row handlers stop propagation, so this never second-guesses
 * a surface that already has a menu open.
 */
export function useNativeContextMenu(): void {
  useEffect(() => {
    const suppress = (e: MouseEvent) => e.preventDefault();

    const fallback = (e: MouseEvent) => {
      const { entries, field } = fallbackEntries(e.target);
      if (entries.length === 0) {
        // No menu for this spot — but a menu opened by the *previous*
        // right-click is still up, and leaving it floating over an
        // unrelated area is worse than dismissing it.
        useContextMenuStore.getState().close();
        return;
      }
      openContextMenu({
        x: e.clientX,
        y: e.clientY,
        entries,
        label: field ? "Text actions" : "Selection actions",
        field,
      });
    };

    document.addEventListener("contextmenu", suppress, true);
    document.addEventListener("contextmenu", fallback);
    return () => {
      document.removeEventListener("contextmenu", suppress, true);
      document.removeEventListener("contextmenu", fallback);
    };
  }, []);
}
