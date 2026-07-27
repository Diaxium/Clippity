import { useCallback, useEffect, useRef, useState } from "react";

import { emitErrorToast } from "@services/tauri/clients/toast";

/** How long the "Copied" state sticks around. Long enough to read,
 *  short enough that a second copy doesn't feel blocked. Matches the
 *  palette swatches, which set this convention. */
const FLASH_MS = 1100;

interface UseCopyFeedbackResult {
  /** True for `FLASH_MS` after a successful copy. */
  copied: boolean;
  /** Write `text` to the clipboard and flash. A blank / null `text` and
   *  a failed write both surface an error toast. */
  copy: (text: string | null) => Promise<boolean>;
}

/**
 * Clipboard write + the brief "Copied" acknowledgement that has to
 * follow it.
 *
 * Copying is the whole point of a color, a palette or a grabbed-text
 * entry — those kinds have no editor to open and no file to reveal — so
 * it happens in a dozen places across the cards, rows and details pane.
 * It also happens *silently*: the clipboard gives no visible sign it
 * changed, and the app's toast channel only accepts errors in MVP (see
 * `showToast`), so success feedback has to be inline. Every call site
 * needing the same flag, the same timeout, and the same cleanup is
 * exactly what a hook is for.
 *
 * The timer is cleared on unmount — a card copied and then scrolled out
 * of the virtualised range would otherwise set state on a dead
 * component.
 */
export function useCopyFeedback(): UseCopyFeedbackResult {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(async (text: string | null) => {
    if (!text) {
      void emitErrorToast("Nothing to copy.");
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      void emitErrorToast("Couldn't write to the clipboard.");
      return false;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), FLASH_MS);
    return true;
  }, []);

  return { copied, copy };
}
