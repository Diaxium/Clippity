import { useCallback, useEffect, useRef, useState } from "react";

import {
  hideToast,
  onToastHide,
  onToastShow,
  type ToastShowEvent,
} from "@services/tauri/clients/toast";

import { EXIT_DURATION_MS, RECONCILE_GRACE_MS } from "../constants";

interface UseToastContentResult {
  /** The full `clippity://toast/show` event (payload fields + durationMs)
   *  or `null` when no toast is active. Pass directly to `renderBody`
   *  — `ToastShowEvent` is structurally a `ToastPayload` plus the
   *  extra `durationMs` field. */
  event: ToastShowEvent | null;
  /** True when the user / auto-dismiss has triggered the exit
   *  animation. AnimatePresence reads this to play the exit transition;
   *  after `EXIT_DURATION_MS`, the OS window is hidden and the state
   *  is cleared so the next toast opens fresh. */
  exiting: boolean;
  /** Start the dismiss flow: flip `exiting=true`. The effect below
   *  handles `hideToast()` IPC + state reset after the animation. */
  dismiss: () => void;
  /** Whether toast transitions may animate at all — false while the page
   *  is not visible to the compositor. See the note on `canAnimate` in
   *  the hook body. */
  canAnimate: boolean;
}

/**
 * Subscribe to backend toast events and own the local
 * `event / exiting` state. The hook is the only place that:
 *
 * - listens to `clippity://toast/show` (replace current event),
 * - listens to `clippity://toast/hide` (clear event without animation),
 * - schedules the post-exit `hideToast()` IPC + state reset,
 * - **reconciles** the OS window against the content it holds.
 *
 * Consumers (the `ToastLayout` component) read the returned state and
 * call `dismiss()` to start the exit flow. Auto-dismiss and manual
 * dismiss both go through the same `dismiss()` path so the exit
 * animation timing stays in one place.
 *
 * **Why reconciliation exists.** Window visibility lives in the backend
 * and content lives here; they are joined only by events, and the sole
 * path that hides the window used to require this hook to be *holding*
 * an event and dismiss it. Any lost, failed, or reordered event
 * (`toast/hide` arriving after a `toast/show`, a `hide_toast` invoke
 * rejecting, a show emitted before this webview registered its
 * listener) therefore stranded a visible-but-empty window on screen
 * with nothing able to clear it. The rule below closes that whole class:
 * *no content ⇒ the window must not be on screen*, re-asserted whenever
 * this hook is empty.
 */
export function useToastContent(): UseToastContentResult {
  const [event, setEvent] = useState<ToastShowEvent | null>(null);
  const [exiting, setExiting] = useState(false);
  /** Whether toast transitions may animate — i.e. whether frames are
   *  actually being produced for this page.
   *
   *  Animations are driven by `requestAnimationFrame`, which does not run
   *  while the page is not visible to the compositor. A toast that mounts
   *  in that state stays parked on its `initial` keyframe, `opacity: 0`,
   *  with the content present in the DOM but nothing painted — and one
   *  that leaves stays mounted forever, because `AnimatePresence` holds
   *  removed children until an exit animation that will never advance
   *  completes. Both leave the window wrong: empty, or showing a toast
   *  that is over.
   *
   *  This is reachable in the real app because the backend reveals the
   *  window and emits the payload in the same breath, while WebView2
   *  clears the window's occluded state asynchronously after
   *  `ShowWindow` — so a payload can genuinely arrive while the page
   *  still counts as hidden, and a sticky HUD then never recovers.
   *  Dropping the transition there costs an animation nobody could have
   *  seen, and makes "content decides what is on screen" true in every
   *  frame rather than only in animated ones. */
  const [canAnimate, setCanAnimate] = useState(true);
  /** True once a hide has been asked for covering the current empty
   *  stretch, so the reconciler doesn't re-ask on every render. Cleared
   *  when a new event arrives (a fresh stretch may need its own hide)
   *  and when a hide invoke fails (so the next transition retries). */
  const hideRequestedRef = useRef(false);

  // Backend pushes a new event each time it shows the toast. Replace
  // immediately (no entry animation flicker — AnimatePresence keys on
  // the kind, which handles the visual swap when kind changes).
  useEffect(() => {
    return onToastShow((e) => {
      hideRequestedRef.current = false;
      // Sampled here as well as on `visibilitychange` because the mount
      // that matters happens in this same tick — the event routinely
      // arrives before the compositor has reported the window visible.
      setCanAnimate(pageIsVisible());
      setEvent(e);
      setExiting(false);
    });
  }, []);

  // Track visibility live, not just at event time: a toast can outlive
  // the transition that mounted it, and its *exit* needs the current
  // answer rather than the one from when it appeared.
  useEffect(() => {
    const sync = () => setCanAnimate(pageIsVisible());
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  // Backend can also push an explicit hide (e.g. after its own
  // `hide_toast` command, including our own post-animation call).
  // Idempotent — we may already be cleared.
  useEffect(() => {
    return onToastHide(() => {
      setEvent(null);
      setExiting(false);
    });
  }, []);

  // After the exit animation completes, hide the OS window so the next
  // toast can be re-positioned fresh. Clearing state here (vs. on the
  // TOAST_HIDE listener) keeps the dismiss flow's timing localized.
  //
  // The hide is requested *before* the content is dropped, and the state
  // reset waits for it to settle: clearing first (the old order) blanks
  // the window for the length of the IPC round-trip, and if that invoke
  // never lands — a rejected command, a backend busy mid-encode — the
  // window was left visible and empty for good. A failure now un-arms
  // `hideRequestedRef` so the reconciler below picks the retry up.
  useEffect(() => {
    if (!exiting) return;
    const id = window.setTimeout(() => {
      hideRequestedRef.current = true;
      void hideToast()
        .catch(() => {
          hideRequestedRef.current = false;
        })
        .finally(() => {
          setEvent(null);
          setExiting(false);
        });
    }, EXIT_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [exiting]);

  // Reconciler: an empty toast window has no reason to be on screen.
  //
  // The grace period is what makes this safe rather than racy — an empty
  // stretch is normal for the instant between two toasts, and hiding
  // eagerly could cancel a show that is still in flight (the backend
  // reveals the window before its payload event reaches us). Waiting,
  // and letting the effect's cleanup cancel the timer the moment an
  // event lands, means only a *persistently* empty window gets hidden.
  useEffect(() => {
    if (event || exiting || hideRequestedRef.current) return;
    const id = window.setTimeout(() => {
      hideRequestedRef.current = true;
      void hideToast().catch(() => {
        hideRequestedRef.current = false;
      });
    }, RECONCILE_GRACE_MS);
    return () => window.clearTimeout(id);
  }, [event, exiting]);

  const dismiss = useCallback(() => {
    setExiting(true);
  }, []);

  return { event, exiting, dismiss, canAnimate };
}

/** Whether this page is being composited, and so whether animation
 *  frames will actually be delivered. Defensive about a missing
 *  `document` so the hook stays usable outside a DOM (SSR-ish test
 *  environments). */
function pageIsVisible(): boolean {
  return typeof document === "undefined" || !document.hidden;
}
