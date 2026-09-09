import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Settings } from "@clippity/shared";
import { useThemeStore } from "@state/themeStore";

import { applyInitialAppearance } from "./initialAppearance";

type InitialAppearance = Pick<Settings, "appearance" | "performance">;

const tuning = {
  glassStrength: 100,
  blurStrength: 100,
  saturation: 100,
  tintStrength: 100,
};

const settings: InitialAppearance = {
  appearance: {
    theme: "dark",
    accent: "#E8D9F2",
    windowOpacity: 100,
    windowBackdrop: "mica",
    backdropTuning: {
      mica: tuning,
      acrylic: tuning,
      blur: tuning,
      tabbed: tuning,
      clear: tuning,
    },
    uiScale: 100,
    cornerRadius: "default",
    density: "comfortable",
    appIcon: "monochrome",
  },
  performance: {
    gpuAcceleration: true,
    windowEffects: true,
    reducedAnimations: true,
    captureCompression: "balanced",
  },
};

function mediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

describe("applyInitialAppearance", () => {
  beforeEach(() => {
    useThemeStore.setState({
      theme: "light",
      reduceMotion: false,
      appIcon: "color",
    });
    document.documentElement.removeAttribute("data-motion");
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.style.removeProperty("--color-accent");
    document.documentElement.style.removeProperty("--color-accent-ink");
    vi.spyOn(window, "matchMedia").mockReturnValue(mediaQuery(false));
  });

  it("applies persisted appearance to the DOM and stores before render", () => {
    applyInitialAppearance(settings);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-motion", "reduced");
    expect(
      document.documentElement.style.getPropertyValue("--color-accent")
    ).toBe("#E8D9F2");
    expect(
      document.documentElement.style.getPropertyValue("--color-accent-ink")
    ).toBe("#23272e");
    expect(useThemeStore.getState()).toMatchObject({
      theme: "dark",
      reduceMotion: true,
      appIcon: "monochrome",
    });
  });

  it("resolves the system preference before the first render", () => {
    vi.mocked(window.matchMedia).mockReturnValue(mediaQuery(true));

    applyInitialAppearance({
      ...settings,
      appearance: { ...settings.appearance, theme: "system" },
    });

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(useThemeStore.getState().theme).toBe("dark");
  });

  it("applies the OS-derived store default when settings are unavailable", () => {
    useThemeStore.setState({ theme: "dark", reduceMotion: false });

    applyInitialAppearance();

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-motion", "normal");
  });
});
