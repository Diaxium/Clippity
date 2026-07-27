import { useCallback, useEffect, useState } from "react";

import { AnimatePresence, motion } from "motion/react";

import { CHROME_HEIGHT } from "../constants";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { useToastContent } from "../hooks/useToastContent";
import { useToastResize } from "../hooks/useToastResize";
import { renderBody, rendersOwnChrome } from "../modes";
import { ProgressBar } from "./ProgressBar";
import { ToastChrome } from "./ToastChrome";

/**
 * Root of the toast window. Three responsibilities:
 *
 * 1. Subscribe to `clippity://toast/show` + `clippity://toast/hide`
 *    via `useToastContent`.
 * 2. Drive auto-dismiss + progress bar via `useAutoDismiss`. Hover
 *    pauses the timer; resume continues from the remainder.
 * 3. Mirror measured content height back to the OS window via
 *    `useToastResize`.
 *
 * Per-variant body components live under `components/<*>Body.tsx`
 * and the dispatch table is `modes.tsx`. MVP only renders an
 * `<ErrorToastBody>`; reserved kinds route through
 * `<UnknownKindBody>`.
 *
 * **Why no `WindowFrame` wrapper.** `WindowFrame` sets
 * `data-tauri-drag-region` on its outermost div so the user can drag
 * the OS window from any non-interactive surface. On a
 * `transparent: true` + `focus: false` window like the toast, that
 * drag-region attribute swallows the `mouseleave` events React's
 * synthetic-event system needs to fire `onMouseLeave` reliably — so
 * `hovered` got stuck at `true` after the first hover. Mirrors the
 * legacy `ToastWindow.tsx`'s bare-div approach. Toasts aren't
 * draggable + don't need the tint/padding.
 */
export function ToastLayout() {
  const { event, exiting, dismiss, canAnimate } = useToastContent();
  const [hovered, setHovered] = useState(false);
  // A callback ref (state, not `useRef`) so `useToastResize` re-runs when
  // the body mounts — the body only exists while a toast is on screen,
  // and a ref object's stable identity never signals that arrival.
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);

  // Reset hover state on every event reference change so the next
  // toast doesn't inherit a stuck `hovered=true` from a previous
  // lifecycle. Even with mouseleave firing reliably (post-
  // `WindowFrame`-removal fix), a relaunch while the cursor is
  // somewhere on the toast position would still carry the old
  // hovered=true forward — and the auto-dismiss timer would never
  // start. This effect makes the contract loud: every new event
  // begins with `hovered=false`; the user can re-hover to pause.
  useEffect(() => {
    setHovered(false);
  }, [event]);

  // Auto-dismiss reads the live event's durationMs (0 = sticky). The
  // expire callback is the same path as the user clicking ✕ — flips
  // exiting=true, the rest of the lifecycle runs in useToastContent.
  const handleExpire = useCallback(() => {
    dismiss();
  }, [dismiss]);

  const { progress } = useAutoDismiss({
    active: !!event && !exiting,
    durationMs: event?.durationMs ?? 0,
    hovered,
    onExpire: handleExpire,
  });

  // A session HUD brings its own cards and controls, so the standard
  // toast card, padding and chrome are dropped for it — see
  // `rendersOwnChrome`, which owns that list next to the body dispatch.
  const isSessionHud = !!event && rendersOwnChrome(event.kind);
  useToastResize(bodyEl, isSessionHud ? 0 : CHROME_HEIGHT);

  const showProgress = !!event && !exiting && (event.durationMs ?? 0) > 0;

  return (
    <div className="h-screen w-screen overflow-hidden select-none">
      <AnimatePresence>
        {event && !exiting && (
          <motion.div
            key={event.kind}
            // Both transitions are dropped when the page isn't being
            // composited, because neither would ever advance a frame (see
            // `canAnimate`): `initial={false}` mounts straight at the
            // `animate` state instead of stranding the card on an
            // `opacity: 0` keyframe, and omitting `exit` lets
            // AnimatePresence unmount immediately instead of holding a
            // finished toast on screen waiting for an animation that
            // cannot run.
            initial={canAnimate ? { opacity: 0, x: 30, scale: 0.96 } : false}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={canAnimate ? { opacity: 0, x: 30, scale: 0.96 } : undefined}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            className={
              isSessionHud
                ? "relative h-full"
                : "float-card relative h-full overflow-hidden border border-[color:var(--hairline)] p-3.5 shadow-[var(--shadow-modal)] backdrop-blur-md"
            }
          >
            {showProgress && <ProgressBar progress={progress} />}
            {/* A session HUD owns its own Stop / Discard controls; the
                chrome's Focus (opens capture window) + × (UI-only
                dismiss) would orphan a running worker, so hide them. */}
            {!isSessionHud && (
              <ToastChrome onFocus={dismiss} onDismiss={dismiss} />
            )}
            <div ref={setBodyEl}>{renderBody(event)}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
