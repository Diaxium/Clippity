/**
 * Countdown feature — public surface.
 *
 * Only `CountdownLayout` is exported. The countdown window mounts it
 * directly; no dashboard surface owns this view.
 */

export { CountdownLayout } from "./components/CountdownLayout";
export { useCountdown } from "./hooks/useCountdown";
