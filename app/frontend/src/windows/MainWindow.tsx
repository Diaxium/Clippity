import { DashboardLayout } from "@features/dashboard";

/**
 * Main window — thin shell that mounts the dashboard. All routing
 * (Library / Editor / Settings switching) lives in `DashboardLayout`.
 */
export function MainWindow() {
  return <DashboardLayout />;
}
