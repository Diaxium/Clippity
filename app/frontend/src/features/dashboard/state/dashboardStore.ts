/**
 * Dashboard view state. Single source of truth for which view the
 * main window is rendering + (when view === "editor") which capture
 * the editor is showing.
 */

import { create } from "zustand";

import type { DashboardView } from "../types";

interface DashboardStoreState {
  view: DashboardView;
  /** Only meaningful for view === "editor". Null otherwise. */
  editorCaptureId: string | null;
  /** The palette aux id for view === "palette". Null otherwise. The
   *  cross-window handoff reuses `DashboardRequest.captureId` to carry it. */
  paletteId: string | null;
  sidebarCollapsed: boolean;

  setView(view: DashboardView, captureId?: string | null): void;
  setSidebarCollapsed(collapsed: boolean): void;
}

export const useDashboardStore = create<DashboardStoreState>((set) => ({
  // Default landing view — the Home overview.
  view: "home",
  editorCaptureId: null,
  paletteId: null,
  sidebarCollapsed: false,

  setView: (view, captureId = null) =>
    set((s) => ({
      view,
      // Keep the prior id when switching to an unrelated view so a
      // round-trip (editor → library → editor) doesn't lose context.
      editorCaptureId:
        view === "editor"
          ? (captureId ?? s.editorCaptureId)
          : s.editorCaptureId,
      paletteId:
        view === "palette" ? (captureId ?? s.paletteId) : s.paletteId,
    })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
}));
