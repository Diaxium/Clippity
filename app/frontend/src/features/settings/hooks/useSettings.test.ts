import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BACKDROP_TUNING_SET } from "../lib/backdrop";

const getSettingsMock = vi.fn();
const onSettingsChangedMock = vi.fn();
const emitErrorToastMock = vi.fn();

vi.mock("@services/tauri/clients/settings", () => ({
  getSettings: () => getSettingsMock(),
  onSettingsChanged: (handler: unknown) => onSettingsChangedMock(handler),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (msg: string) => emitErrorToastMock(msg),
}));

import { useSettingsStore } from "../state/settingsStore";
import { useSettings } from "./useSettings";

const sample = {
  general: {
    capturesDir: "",
    startOnStartup: false,
    onboarded: true,
  },
  appearance: {
    theme: "system" as const,
    accent: "#FF6E4A",
    windowOpacity: 100,
    windowBackdrop: "mica",
    backdropTuning: DEFAULT_BACKDROP_TUNING_SET,
    uiScale: 100,
    cornerRadius: "default" as const,
    density: "comfortable" as const,
    appIcon: "color" as const,
  },
  notifications: {
    corner: "bottom-right" as const,
    durations: {
      color: 8000,
      palette: 9000,
      clipboard: 0,
      text: 0,
      recording: 0,
      error: 6000,
    },
  },
};

describe("useSettings", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null });
    getSettingsMock.mockReset();
    onSettingsChangedMock.mockReset();
    emitErrorToastMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates the store from getSettings on mount", async () => {
    getSettingsMock.mockResolvedValueOnce(sample);
    onSettingsChangedMock.mockReturnValueOnce(() => {});
    renderHook(() => useSettings());
    await waitFor(() =>
      expect(useSettingsStore.getState().settings).toEqual(sample)
    );
  });

  it("subscribes to settings change events on mount", async () => {
    getSettingsMock.mockResolvedValueOnce(sample);
    onSettingsChangedMock.mockReturnValueOnce(() => {});
    renderHook(() => useSettings());
    // Wait for the async hydration to flush so the React state update
    // happens inside `act` (otherwise the testing-library wrapper
    // logs an "update not wrapped in act" warning — harmless but
    // noisy for `npm test`'s clean output).
    await waitFor(() => expect(onSettingsChangedMock).toHaveBeenCalledTimes(1));
  });

  it("emits an error toast when getSettings rejects", async () => {
    getSettingsMock.mockRejectedValueOnce(new Error("boom"));
    onSettingsChangedMock.mockReturnValueOnce(() => {});
    renderHook(() => useSettings());
    await waitFor(() =>
      expect(emitErrorToastMock).toHaveBeenCalledWith(
        expect.stringContaining("boom")
      )
    );
  });

  it("calls the unsubscribe on unmount", () => {
    const unsub = vi.fn();
    getSettingsMock.mockResolvedValueOnce(sample);
    onSettingsChangedMock.mockReturnValueOnce(unsub);
    const { unmount } = renderHook(() => useSettings());
    unmount();
    expect(unsub).toHaveBeenCalled();
  });
});
