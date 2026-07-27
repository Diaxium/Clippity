/**
 * Toast feature — public surface.
 *
 * Only `ToastLayout` is exported. Anything that wants to *emit* a
 * toast imports from `@services/tauri/clients/toast` (the cross-
 * feature seam per ADR 0001).
 */

export { ToastLayout } from "./components/ToastLayout";
