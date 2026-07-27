import { beforeEach, describe, expect, it, vi } from "vitest";

const onCaptureFinishedMock = vi.fn();
const openDashboardMock = vi.fn();

vi.mock("@services/tauri/clients/capture", () => ({
  onCaptureFinished: (...a: unknown[]) => onCaptureFinishedMock(...a),
}));
vi.mock("@services/tauri/clients/dashboard", () => ({
  openDashboard: (...a: unknown[]) => openDashboardMock(...a),
}));

import { renderHook } from "@testing-library/react";

import type { CaptureResult } from "@services/tauri/clients/capture";

import { useOpenEditorOnPreview } from "./useOpenEditorOnPreview";

function result(preview: boolean): CaptureResult {
  return {
    id: "cap_1",
    type: "fullscreen",
    customMode: null,
    width: 10,
    height: 10,
    path: "/captures/x.png",
    preview,
  };
}

describe("useOpenEditorOnPreview", () => {
  let handler: ((r: CaptureResult) => void) | undefined;
  const unsubscribe = vi.fn();

  beforeEach(() => {
    handler = undefined;
    unsubscribe.mockReset();
    openDashboardMock.mockReset();
    onCaptureFinishedMock.mockReset().mockImplementation((h) => {
      handler = h as (r: CaptureResult) => void;
      return unsubscribe;
    });
  });

  it("opens the editor on the capture's path when preview is on", () => {
    renderHook(() => useOpenEditorOnPreview());
    handler?.(result(true));
    expect(openDashboardMock).toHaveBeenCalledWith("editor", "/captures/x.png");
  });

  it("ignores captures taken with preview off", () => {
    renderHook(() => useOpenEditorOnPreview());
    handler?.(result(false));
    expect(openDashboardMock).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount so a hidden window stops listening", () => {
    const { unmount } = renderHook(() => useOpenEditorOnPreview());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
