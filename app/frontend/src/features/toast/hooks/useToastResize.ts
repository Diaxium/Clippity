import { useLayoutEffect, useRef } from "react";

import { resizeToast } from "@services/tauri/clients/toast";

import {
  CHROME_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  TOAST_WIDTH,
} from "../constants";

/**
 * Drive `resize_toast` IPC from a ResizeObserver on the toast body.
 *
 * The toast window is pre-declared at 380×156 but the rendered body
 * height varies by payload kind (an error toast is shorter than a
 * recording toast with a preview image, for example). On every
 * measured-height change, this hook clamps the measurement to the
 * sane envelope and calls `resize_toast` so the OS window grows to
 * fit.
 *
 * **Idempotent skip**: the hook tracks the last height it sent and
 * short-circuits if the new measurement matches — saves an IPC trip
 * on every content swap that happens to measure to the same size
 * (most error toasts measure identically, for instance).
 *
 * `chromeHeight` is the fixed vertical space *outside* the measured body
 * that the window still needs: the single card's padding for normal
 * toasts (default), or `0` for the recording HUD, whose body renders its
 * own cards bare (ToastLayout drops the outer card for that kind).
 *
 * **Takes the element, not a ref.** The body only exists while a toast is
 * on screen, so at mount there is nothing to measure — and a `RefObject`
 * keeps the same identity when `.current` is filled in, so an effect
 * keyed on the ref never re-runs to pick the element up. That left the
 * observer permanently unattached for every toast after the first mount:
 * pass the element from a callback ref (`useState`) so mounting the body
 * is itself the dependency change that arms the observer.
 */
export function useToastResize(
  el: HTMLElement | null,
  chromeHeight: number = CHROME_HEIGHT
): void {
  const lastHRef = useRef(0);

  useLayoutEffect(() => {
    if (!el) return;

    const push = () => {
      const measured = el.scrollHeight + chromeHeight;
      const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, measured));
      if (h === lastHRef.current) return;
      lastHRef.current = h;
      void resizeToast(TOAST_WIDTH, h);
    };

    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, chromeHeight]);
}
