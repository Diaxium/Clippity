import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CapturePreset } from "./presets";

const captureFullscreenMock = vi.fn();
const beginRegionCaptureMock = vi.fn();
const emitOverlayTogglesMock = vi.fn();
const emitErrorToastMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: vi.fn(),
  on: vi.fn(),
  EVENT_NAMES: { presetsChanged: "clippity://presets/changed" },
}));
vi.mock("./capture", () => ({
  captureFullscreen: (...args: unknown[]) => captureFullscreenMock(...args),
}));
vi.mock("./overlay", () => ({
  beginRegionCapture: (...args: unknown[]) => beginRegionCaptureMock(...args),
  emitOverlayToggles: (...args: unknown[]) => emitOverlayTogglesMock(...args),
}));
vi.mock("./toast", () => ({
  emitErrorToast: (...args: unknown[]) => emitErrorToastMock(...args),
}));

import { runPreset } from "./presets";

function preset(overrides: Partial<CapturePreset> = {}): CapturePreset {
  return {
    id: "preset_1",
    name: "Docs shot",
    request: {
      type: "fullscreen",
      customMode: null,
      toggles: {
        preview: false,
        clipboard: true,
        cursor: false,
        enhance: false,
      },
      delay: null,
      effect: null,
      share: null,
    },
    output: { openEditor: false, saveDir: null },
    ...overrides,
  };
}

describe("runPreset", () => {
  beforeEach(() => {
    captureFullscreenMock.mockReset().mockResolvedValue(undefined);
    beginRegionCaptureMock.mockReset().mockResolvedValue(undefined);
    emitOverlayTogglesMock.mockReset().mockResolvedValue(undefined);
    emitErrorToastMock.mockReset().mockResolvedValue(undefined);
  });

  it("stamps the preset's name onto a fullscreen capture", async () => {
    // The backend can't observe which preset is running — this is the
    // only place the provenance record can learn it.
    await runPreset(preset());
    expect(captureFullscreenMock).toHaveBeenCalledWith(
      expect.objectContaining({ preset: "Docs shot", outputDir: null })
    );
  });

  it("stamps the preset's name onto the overlay session", async () => {
    await runPreset(
      preset({
        name: "Bug report",
        request: { ...preset().request, type: "region" },
        output: { openEditor: false, saveDir: "/caps" },
      })
    );
    expect(beginRegionCaptureMock).toHaveBeenCalledWith(
      "region",
      "/caps",
      "Bug report"
    );
  });

  it("records the preset's CURRENT name, not one saved in its request", async () => {
    // `preset.request.preset` is never persisted; renaming a preset must
    // change what its captures record.
    const renamed = preset({ name: "Renamed" });
    renamed.request.preset = "Old name";
    await runPreset(renamed);
    expect(captureFullscreenMock).toHaveBeenCalledWith(
      expect.objectContaining({ preset: "Renamed" })
    );
  });

  it("folds openEditor into preview without disturbing the name", async () => {
    await runPreset(preset({ output: { openEditor: true, saveDir: null } }));
    expect(captureFullscreenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: "Docs shot",
        toggles: expect.objectContaining({ preview: true }),
      })
    );
  });

  it("surfaces a dispatch failure as an error toast rather than throwing", async () => {
    captureFullscreenMock.mockRejectedValueOnce(new Error("io: disk full"));
    await expect(runPreset(preset())).resolves.toBeUndefined();
    expect(emitErrorToastMock).toHaveBeenCalledWith("io: disk full");
  });

  it("dispatches nothing for a custom-mode preset", async () => {
    await runPreset(
      preset({ request: { ...preset().request, type: "custom" } })
    );
    expect(captureFullscreenMock).not.toHaveBeenCalled();
    expect(beginRegionCaptureMock).not.toHaveBeenCalled();
  });
});
