import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapturePreset } from "@services/tauri/clients/presets";

const isTauriContextMock = vi.fn();
const presetsListMock = vi.fn();
let changedHandler: ((p: CapturePreset[]) => void) | null = null;

vi.mock("@services/tauri", () => ({
  isTauriContext: () => isTauriContextMock(),
}));

vi.mock("@services/tauri/clients/presets", () => ({
  presetsList: () => presetsListMock(),
  onPresetsChanged: (h: (p: CapturePreset[]) => void) => {
    changedHandler = h;
    return () => {
      if (changedHandler === h) changedHandler = null;
    };
  },
}));

import { usePresets } from "./usePresets";

function preset(id: string): CapturePreset {
  return {
    id,
    name: id,
    request: {
      type: "fullscreen",
      customMode: null,
      toggles: {
        preview: false,
        clipboard: false,
        cursor: false,
        enhance: false,
      },
      delay: null,
      effect: null,
      share: null,
    },
    output: { openEditor: false, saveDir: null },
  };
}

describe("usePresets", () => {
  beforeEach(() => {
    isTauriContextMock.mockReset().mockReturnValue(true);
    presetsListMock.mockReset().mockResolvedValue([]);
    changedHandler = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads presets on mount", async () => {
    presetsListMock.mockResolvedValue([preset("a"), preset("b")]);
    const { result } = renderHook(() => usePresets());
    await waitFor(() => expect(result.current.presets).toHaveLength(2));
  });

  it("replaces the list when presets/changed fires", async () => {
    presetsListMock.mockResolvedValue([preset("a")]);
    const { result } = renderHook(() => usePresets());
    await waitFor(() => expect(result.current.presets).toHaveLength(1));
    act(() => changedHandler?.([preset("x"), preset("y"), preset("z")]));
    expect(result.current.presets).toHaveLength(3);
  });

  it("stays empty outside a Tauri context", async () => {
    isTauriContextMock.mockReturnValue(false);
    presetsListMock.mockResolvedValue([preset("a")]);
    const { result } = renderHook(() => usePresets());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.presets).toHaveLength(0);
    expect(presetsListMock).not.toHaveBeenCalled();
  });
});
