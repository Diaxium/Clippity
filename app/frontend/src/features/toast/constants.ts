/**
 * Toast measurement + animation constants. Values inherited from
 * legacy `ToastWindow.tsx` — confirmed sufficient through Step 4
 * manual validation of the capture + overlay ports.
 */

/** Width of the toast window in logical pixels. Matches the
 *  `tauri.conf.json` declared width so the first frame doesn't shift. */
export const TOAST_WIDTH = 380;

/** Vertical padding the `.float-card` wrapper adds around the
 *  measured content (p-3.5 = 14px top + 14px bottom + a hair of
 *  shadow-clip safety). */
export const CHROME_HEIGHT = 30;

/** Defensive bounds — the backend clamps too. */
export const MIN_HEIGHT = 96;
export const MAX_HEIGHT = 480;

/** Duration of the AnimatePresence exit transition. The frontend
 *  waits this many ms after `exiting=true` before calling
 *  `hideToast()` IPC so the user sees the exit animation, not an
 *  instant disappear. Must match the motion `transition.duration`
 *  in `ToastLayout`. */
export const EXIT_DURATION_MS = 220;

/** How long the toast window may sit with no content before
 *  `useToastContent`'s reconciler hides it.
 *
 *  Comfortably longer than `EXIT_DURATION_MS` so it never races the
 *  normal dismiss flow, and long enough to cover the gap between the
 *  backend revealing the window and its `toast/show` payload arriving
 *  — an empty window is only pathological once it *stays* empty. */
export const RECONCILE_GRACE_MS = 400;
