import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const finishFullscreenCaptureMock = vi.fn();
const cancelRegionCaptureMock = vi.fn();
const beginRegionCaptureMock = vi.fn();
const emitErrorToastMock = vi.fn();

vi.mock("@services/tauri/clients/overlay", () => ({
  finishFullscreenCapture: (...a: unknown[]) =>
    finishFullscreenCaptureMock(...a),
  cancelRegionCapture: (...a: unknown[]) => cancelRegionCaptureMock(...a),
  beginRegionCapture: (...a: unknown[]) => beginRegionCaptureMock(...a),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...a: unknown[]) => emitErrorToastMock(...a),
}));

import { useOverlayStore } from "../state/overlayStore";
import { captureFullscreenFromOverlay } from "./fullscreenCapture";

beforeEach(() => {
  finishFullscreenCaptureMock.mockReset().mockResolvedValue({
    id: "cap_1",
    width: 1920,
    height: 1080,
    path: "C:\\shots\\Fullscreen.png",
    preview: false,
  });
  cancelRegionCaptureMock.mockReset();
  beginRegionCaptureMock.mockReset();
  emitErrorToastMock.mockReset();
  act(() => {
    useOverlayStore.getState().reset();
  });
});

describe("captureFullscreenFromOverlay", () => {
  it("captures instead of cancelling back to the capture window", async () => {
    // The old behaviour: cancel the overlay, re-open it in Region mode,
    // and leave the user to press Capture again. Nothing gets captured.
    captureFullscreenFromOverlay();
    await vi.waitFor(() =>
      expect(finishFullscreenCaptureMock).toHaveBeenCalledTimes(1)
    );
    expect(cancelRegionCaptureMock).not.toHaveBeenCalled();
    expect(beginRegionCaptureMock).not.toHaveBeenCalled();
  });

  it("sends the overlay's current toggles, and no rect", async () => {
    act(() => {
      useOverlayStore
        .getState()
        .setToggles({ clipboard: true, enhance: true, cursor: true });
    });
    captureFullscreenFromOverlay();

    await vi.waitFor(() =>
      expect(finishFullscreenCaptureMock).toHaveBeenCalled()
    );
    // The backend picks the monitor itself (the one under the cursor) out
    // of the cached snapshot — the frontend has no monitor bounds to send,
    // so `toggles` is the whole payload.
    expect(finishFullscreenCaptureMock).toHaveBeenCalledWith({
      preview: true,
      clipboard: true,
      cursor: true,
      enhance: true,
    });
    expect(finishFullscreenCaptureMock.mock.calls[0]).toHaveLength(1);
  });

  it("fires the capture flash", () => {
    const before = useOverlayStore.getState().captureFlash;
    captureFullscreenFromOverlay();
    expect(useOverlayStore.getState().captureFlash).toBeGreaterThan(before);
  });

  it("resets the overlay once the capture lands", async () => {
    act(() => {
      useOverlayStore.setState({ phase: "selected" });
    });
    captureFullscreenFromOverlay();
    await vi.waitFor(() =>
      expect(useOverlayStore.getState().phase).toBe("empty")
    );
  });

  it("toasts and leaves the overlay alone when the capture fails", async () => {
    // e.g. a monitor hot-plugged after the snapshot was taken — the
    // backend rejects rather than cropping the wrong pixels.
    finishFullscreenCaptureMock.mockRejectedValueOnce(
      new Error("that monitor is outside the captured desktop")
    );
    captureFullscreenFromOverlay();
    await vi.waitFor(() =>
      expect(emitErrorToastMock).toHaveBeenCalledWith(
        "that monitor is outside the captured desktop"
      )
    );
  });
});
