/**
 * Capture-window state.
 *
 * Feature-local Zustand slice. Mode selection, option toggles, output
 * dropdowns, sidebar layout — anything specific to the capture window
 * itself. Cross-window settings (compact layout, theme) come through
 * the global stores or are deferred until settings is ported.
 */

import { create } from "zustand";

import type { ScrollDirection } from "@services/tauri/clients/scroll";
import type {
  RecorderFormat,
  RecorderTarget,
} from "@services/tauri/clients/recorder";

import type { CaptureSettings } from "@clippity/shared";

import type {
  CaptureNav,
  CaptureRequest,
  CaptureType,
  CustomMode,
} from "../types";
import { DEFAULT_TOGGLES } from "../modes";

interface CaptureStoreState {
  // ---- Nav + mode -----------------------------------------------------
  nav: CaptureNav;
  captureType: CaptureType;
  customMode: CustomMode | null;

  // ---- Options --------------------------------------------------------
  preview: boolean;
  clipboard: boolean;
  cursor: boolean;
  /** Backend Smart-enhance pass (auto-levels + light unsharp). */
  enhance: boolean;
  delayEnabled: boolean;
  /** 1..60 — clamped by setDelaySeconds. */
  delaySeconds: number;
  /** Scroll/stitch direction for Scrolling-Window + Panoramic modes. */
  scrollDirection: ScrollDirection;

  // ---- Recording (ADR 0031) -------------------------------------------
  //
  // Only the two *per-session* choices live here. Everything else the
  // Record screen offers — audio inputs, frame rate, cursor — is a
  // persisted preference the panel reads and patches directly in
  // Settings → Recording, the same way the palette swatch count does.
  // Duplicating them into session state would mean a value the user
  // sets on this screen quietly not being the one a hotkey uses.
  /** What surface a recording captures. */
  recordTarget: RecorderTarget;
  /** Which encoder the session feeds. */
  recordFormat: RecorderFormat;

  // ---- Output controls ------------------------------------------------
  effect: string;
  share: string;

  // ---- Layout state ---------------------------------------------------
  sidebarCollapsed: boolean;

  // ---- Defaults hydration --------------------------------------------
  /** True once the persisted capture defaults have seeded this store.
   *  Guards `hydrateDefaults` so it runs at most once per window realm —
   *  a later settings edit (or re-hydration on window re-show) never
   *  clobbers the user's in-session option tweaks. */
  defaultsHydrated: boolean;

  // ---- Actions --------------------------------------------------------
  setNav(nav: CaptureNav): void;
  setCaptureType(type: CaptureType): void;
  setCustomMode(mode: CustomMode | null): void;
  setOption(
    key: "preview" | "clipboard" | "cursor" | "enhance",
    on: boolean
  ): void;
  setDelayEnabled(on: boolean): void;
  setDelaySeconds(s: number): void;
  setScrollDirection(d: ScrollDirection): void;
  setRecordTarget(t: RecorderTarget): void;
  setRecordFormat(f: RecorderFormat): void;
  setEffect(e: string): void;
  setShare(s: string): void;
  setSidebarCollapsed(c: boolean): void;
  /** Seed the per-session option state from the persisted capture
   *  defaults. No-op after the first call (see `defaultsHydrated`). */
  hydrateDefaults(defaults: CaptureSettings): void;
}

const MIN_DELAY = 1;
const MAX_DELAY = 60;

export const useCaptureStore = create<CaptureStoreState>((set) => ({
  nav: "capture",
  // Region is the legacy default — restored now that the overlay port
  // has landed and the Region tile is armable again.
  captureType: "region",
  customMode: null,

  preview: DEFAULT_TOGGLES.preview,
  clipboard: DEFAULT_TOGGLES.clipboard,
  cursor: DEFAULT_TOGGLES.cursor,
  enhance: DEFAULT_TOGGLES.enhance,
  delayEnabled: DEFAULT_TOGGLES.delay,
  delaySeconds: 5,
  scrollDirection: "down",

  // Fullscreen is the only armable target today, so starting there
  // means the screen opens on something that works rather than on a
  // "Soon" tile.
  recordTarget: "fullscreen",
  recordFormat: "mp4",

  effect: "none",
  share: "none",

  sidebarCollapsed: false,

  defaultsHydrated: false,

  setNav: (nav) => set({ nav }),
  setCaptureType: (captureType) =>
    set((s) => ({
      captureType,
      // Switching away from custom clears the sub-mode so the request
      // shape stays well-formed.
      customMode: captureType === "custom" ? s.customMode : null,
    })),
  setCustomMode: (customMode) => set({ customMode }),
  setOption: (key, on) => set({ [key]: on } as Partial<CaptureStoreState>),
  setDelayEnabled: (delayEnabled) => set({ delayEnabled }),
  setDelaySeconds: (s) =>
    set({ delaySeconds: Math.max(MIN_DELAY, Math.min(MAX_DELAY, s)) }),
  setScrollDirection: (scrollDirection) => set({ scrollDirection }),
  setRecordTarget: (recordTarget) => set({ recordTarget }),
  setRecordFormat: (recordFormat) => set({ recordFormat }),
  setEffect: (effect) => set({ effect }),
  setShare: (share) => set({ share }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  hydrateDefaults: (d) =>
    set((s) =>
      s.defaultsHydrated
        ? s
        : {
            defaultsHydrated: true,
            preview: d.preview,
            clipboard: d.clipboard,
            cursor: d.cursor,
            enhance: d.enhance,
            delayEnabled: d.delay,
            delaySeconds: Math.max(
              MIN_DELAY,
              Math.min(MAX_DELAY, d.delaySeconds)
            ),
            scrollDirection: d.scrollDirection,
          }
    ),
}));

/**
 * Derive the backend's `CaptureRequest` from the current store state.
 * Pure — kept here (rather than as a Zustand selector) so the unit
 * tests can call it with a hand-rolled state value.
 */
export function buildRequest(s: CaptureStoreState): CaptureRequest {
  return {
    type: s.captureType,
    customMode: s.captureType === "custom" ? s.customMode : null,
    toggles: {
      preview: s.preview,
      clipboard: s.clipboard,
      cursor: s.cursor,
      enhance: s.enhance,
    },
    delay: s.delayEnabled ? { seconds: s.delaySeconds } : null,
    effect: s.effect === "none" ? null : s.effect,
    share: s.share === "none" ? null : s.share,
  };
}

export type { CaptureStoreState };
