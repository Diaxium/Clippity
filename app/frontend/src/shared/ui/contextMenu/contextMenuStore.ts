import { create } from "zustand";

import type { OpenContextMenu } from "./types";

interface ContextMenuStoreState {
  /** The open menu, or `null`. One per window — opening a second one
   *  replaces the first, which is what a right-click elsewhere means. */
  menu: OpenContextMenu | null;
  open(menu: OpenContextMenu): void;
  close(): void;
}

export const useContextMenuStore = create<ContextMenuStoreState>((set) => ({
  menu: null,
  open: (menu) => set({ menu }),
  // Guarded so the many close paths (outside press, Escape, scroll, blur,
  // route change) don't each publish a no-op state change to every
  // subscriber when the menu is already shut.
  close: () => set((s) => (s.menu ? { menu: null } : {})),
}));

/** Imperative open, for the non-React global `contextmenu` listener. */
export function openContextMenu(menu: OpenContextMenu): void {
  useContextMenuStore.getState().open(menu);
}

export function closeContextMenu(): void {
  useContextMenuStore.getState().close();
}
