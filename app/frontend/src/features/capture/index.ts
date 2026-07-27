/**
 * Public surface of the capture feature.
 *
 * The window component in `windows/CaptureWindow.tsx` is the only
 * consumer in MVP. Internals (store, hooks, services, types) stay
 * private — pull them in via deep imports only from inside the
 * feature folder.
 */
export { CaptureLayout } from "./components/CaptureLayout";
