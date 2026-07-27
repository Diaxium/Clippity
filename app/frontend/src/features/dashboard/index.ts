/**
 * Dashboard feature — public surface.
 *
 * Only `DashboardLayout` is exported. The main window mounts it.
 * Cross-window handoff helpers (`openDashboard`,
 * `requestDashboardView`, `onDashboardView`) live in
 * `@services/tauri/clients/dashboard`.
 */

export { DashboardLayout } from "./components/DashboardLayout";
