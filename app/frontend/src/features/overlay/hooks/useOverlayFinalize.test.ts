import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const finishRegionCaptureMock = vi.fn();
const finishFreehandCaptureMock = vi.fn();
const finishBrushCaptureMock = vi.fn();
const finishMultiAreaCaptureMock = vi.fn();
const finishPaletteCaptureMock = vi.fn();
const finishGrabTextMock = vi.fn();
const startScrollCaptureMock = vi.fn();
const startPanoramicCaptureMock = vi.fn();
const startRecordingMock = vi.fn();
const emitErrorToastMock = vi.fn();
const readMaskRLEMock = vi.fn();

vi.mock("@services/tauri/clients/overlay", () => ({
  finishRegionCapture: (...a: unknown[]) => finishRegionCaptureMock(...a),
  finishFreehandCapture: (...a: unknown[]) => finishFreehandCaptureMock(...a),
  finishBrushCapture: (...a: unknown[]) => finishBrushCaptureMock(...a),
  finishMultiAreaCapture: (...a: unknown[]) => finishMultiAreaCaptureMock(...a),
  finishPaletteCapture: (...a: unknown[]) => finishPaletteCaptureMock(...a),
  finishGrabText: (...a: unknown[]) => finishGrabTextMock(...a),
}));
// The brush mask lives in an offscreen canvas (no 2D context under jsdom),
// so stub the module: readMaskRLE feeds finalize, clearMask is a no-op the
// store calls on reset.
vi.mock("../brushMask", () => ({
  readMaskRLE: () => readMaskRLEMock(),
  clearMask: () => {},
  hasInk: () => true,
  maskBounds: () => null,
  maskCanvas: () => null,
  paintSegment: () => {},
}));
vi.mock("@services/tauri/clients/scroll", () => ({
  startScrollCapture: (...a: unknown[]) => startScrollCaptureMock(...a),
  startPanoramicCapture: (...a: unknown[]) => startPanoramicCaptureMock(...a),
}));
vi.mock("@services/tauri/clients/recorder", () => ({
  startRecording: (...a: unknown[]) => startRecordingMock(...a),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...a: unknown[]) => emitErrorToastMock(...a),
}));

import { act, renderHook } from "@testing-library/react";

import { useOverlayStore } from "../state/overlayStore";
import { useOverlayFinalize } from "./useOverlayFinalize";

const initial = useOverlayStore.getState();
const result = { id: "x", width: 1, height: 1, path: "p" };

describe("useOverlayFinalize", () => {
  beforeEach(() => {
    finishRegionCaptureMock.mockReset().mockResolvedValue(result);
    finishFreehandCaptureMock.mockReset().mockResolvedValue(result);
    finishBrushCaptureMock.mockReset().mockResolvedValue(result);
    readMaskRLEMock.mockReset().mockReturnValue(null);
    finishMultiAreaCaptureMock.mockReset().mockResolvedValue(result);
    finishPaletteCaptureMock.mockReset().mockResolvedValue(result);
    finishGrabTextMock.mockReset().mockResolvedValue("hello world");
    startScrollCaptureMock.mockReset().mockResolvedValue(undefined);
    startPanoramicCaptureMock.mockReset().mockResolvedValue(undefined);
    startRecordingMock.mockReset().mockResolvedValue(undefined);
    emitErrorToastMock.mockReset();
    useOverlayStore.setState(initial, true);
    // DPR = 2 verifies the logical→physical scaling at the IPC seam.
    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "devicePixelRatio", {
      value: 1,
      configurable: true,
    });
  });

  it("region: ready when selected; finalize scales rect + pin by DPR", async () => {
    const st = useOverlayStore.getState();
    st.setMode("region");
    st.startDrag({ x: 0, y: 0 });
    st.endDrag({ x: 10, y: 20, w: 30, h: 40 });
    st.setCursorPin({ x: 15, y: 25 });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    expect(finishRegionCaptureMock).toHaveBeenCalledWith({
      rect: { x: 20, y: 40, width: 60, height: 80 },
      cursorPin: [30, 50],
      toggles: { preview: true, clipboard: false, cursor: false, enhance: false },
    });
  });

  it("freehand: not ready below the minimum points", () => {
    const st = useOverlayStore.getState();
    st.setMode("freehand");
    st.beginFreehand({ x: 1, y: 1 });
    st.extendFreehand({ x: 5, y: 1 }); // 2 points, still dragging

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(false);
  });

  it("freehand: ready when selected; finalize scales the path by DPR", async () => {
    const st = useOverlayStore.getState();
    st.setMode("freehand");
    st.beginFreehand({ x: 1, y: 1 });
    st.extendFreehand({ x: 5, y: 1 });
    st.extendFreehand({ x: 3, y: 6 });
    st.endFreehand(true);

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    expect(finishFreehandCaptureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        points: [
          [2, 2],
          [10, 2],
          [6, 12],
        ],
      })
    );
  });

  it("magnetic-lasso: reuses the freehand path + sink, scaled by DPR", async () => {
    const st = useOverlayStore.getState();
    st.setMode("magnetic-lasso");
    st.beginFreehand({ x: 1, y: 1 });
    st.extendFreehand({ x: 5, y: 1 });
    st.extendFreehand({ x: 3, y: 6 });
    st.endFreehand(true);

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    expect(finishFreehandCaptureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        points: [
          [2, 2],
          [10, 2],
          [6, 12],
        ],
      })
    );
  });

  it("pen: not ready until the path is closed with ≥3 anchors", () => {
    const st = useOverlayStore.getState();
    st.setMode("pen");
    st.addPenAnchor({ p: { x: 0, y: 0 }, hIn: null, hOut: null });
    st.addPenAnchor({ p: { x: 8, y: 0 }, hIn: null, hOut: null });
    st.addPenAnchor({ p: { x: 8, y: 8 }, hIn: null, hOut: null });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    // Still "dragging" — closePen hasn't run.
    expect(hook.current.ready).toBe(false);
  });

  it("pen: flattens the closed path to a polygon and reuses the freehand sink", async () => {
    const st = useOverlayStore.getState();
    st.setMode("pen");
    st.addPenAnchor({ p: { x: 0, y: 0 }, hIn: null, hOut: null });
    st.addPenAnchor({ p: { x: 8, y: 0 }, hIn: null, hOut: null });
    st.addPenAnchor({ p: { x: 8, y: 8 }, hIn: null, hOut: null });
    st.closePen();

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    // Corner-only triangle flattens to its three corners, DPR-scaled.
    expect(finishFreehandCaptureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        points: [
          [0, 0],
          [16, 0],
          [16, 16],
        ],
      })
    );
  });

  it("brush: ready when selected with ink; finalize sends the RLE mask + scaled pin", async () => {
    const mask = {
      x: 4,
      y: 5,
      width: 2,
      height: 2,
      rle: [[255, 4]] as [number, number][],
    };
    readMaskRLEMock.mockReturnValue(mask);
    const st = useOverlayStore.getState();
    st.setMode("brush");
    st.bumpBrush(); // → dragging
    st.commitBrush(true); // → selected, has ink
    st.setCursorPin({ x: 3, y: 3 });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    // The mask is already physical px (no DPR scaling); only the cursor
    // pin scales by DPR (=2).
    expect(finishBrushCaptureMock).toHaveBeenCalledWith(
      expect.objectContaining({ mask, cursorPin: [6, 6] })
    );
  });

  it("brush: not ready without ink", () => {
    const st = useOverlayStore.getState();
    st.setMode("brush");
    st.commitBrush(false);
    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(false);
  });

  it("multi-area: ready with ≥1 area; finalize scales every rect", async () => {
    const st = useOverlayStore.getState();
    st.setMode("multi-area");
    st.commitArea({ x: 0, y: 0, w: 10, h: 10 });
    st.commitArea({ x: 20, y: 5, w: 8, h: 12 });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    expect(finishMultiAreaCaptureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rects: [
          { x: 0, y: 0, width: 20, height: 20 },
          { x: 40, y: 10, width: 16, height: 24 },
        ],
      })
    );
  });

  it("palette: ready when selected; finalize scales the rect", async () => {
    const st = useOverlayStore.getState();
    st.setMode("palette");
    st.startDrag({ x: 0, y: 0 });
    st.endDrag({ x: 5, y: 6, w: 30, h: 20 });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    expect(finishPaletteCaptureMock).toHaveBeenCalledWith({
      x: 10,
      y: 12,
      width: 60,
      height: 40,
    });
  });

  it("grab-text: ready when selected; finalize scales the rect", async () => {
    const st = useOverlayStore.getState();
    st.setMode("grab-text");
    st.startDrag({ x: 0, y: 0 });
    st.endDrag({ x: 3, y: 4, w: 20, h: 10 });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    expect(finishGrabTextMock).toHaveBeenCalledWith({
      x: 6,
      y: 8,
      width: 40,
      height: 20,
    });
  });

  it("scrolling: ready when selected; finalize starts a recording with the scaled rect", async () => {
    const st = useOverlayStore.getState();
    st.setMode("scrolling");
    st.startDrag({ x: 0, y: 0 });
    st.endDrag({ x: 5, y: 6, w: 30, h: 20 });
    st.setToggles({ clipboard: true });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    // clipboard + preview (default-on) ride through to the recording so
    // the stitched result honors the "Preview in Editor" toggle. The
    // scroll direction (default "down") rides along too.
    expect(startScrollCaptureMock).toHaveBeenCalledWith(
      { x: 10, y: 12, width: 60, height: 40 },
      "down",
      true,
      true
    );
  });

  it("scrolling: forwards preview=false when the toggle is off", async () => {
    const st = useOverlayStore.getState();
    st.setMode("scrolling");
    st.startDrag({ x: 0, y: 0 });
    st.endDrag({ x: 5, y: 6, w: 30, h: 20 });
    st.setToggles({ preview: false });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    await act(async () => {
      hook.current.finalize();
    });
    // clipboard defaults off too — both flags pass through verbatim.
    expect(startScrollCaptureMock).toHaveBeenCalledWith(
      { x: 10, y: 12, width: 60, height: 40 },
      "down",
      false,
      false
    );
  });

  it("record-region: finalize starts a recorder session for the rect", async () => {
    const st = useOverlayStore.getState();
    st.setMode("record-region");
    st.startDrag({ x: 0, y: 0 });
    st.endDrag({ x: 5, y: 6, w: 30, h: 20 });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });

    // The rect is DPR-scaled at the seam exactly as every other
    // region-like mode does, and rides inside the request.
    expect(startRecordingMock).toHaveBeenCalledTimes(1);
    const req = startRecordingMock.mock.calls[0]?.[0];
    expect(req.target).toBe("region");
    expect(req.region).toEqual({ x: 10, y: 12, width: 60, height: 40 });
    // Nothing was captured — a still-capture path must not fire.
    expect(finishRegionCaptureMock).not.toHaveBeenCalled();
  });

  it("record-region: encodes to the format mirrored from the Record screen", async () => {
    // The overlay is a different window and can't see that selection,
    // so a GIF chosen there has to arrive through the mirror event or
    // every overlay-started recording would silently be an MP4.
    const st = useOverlayStore.getState();
    st.setMode("record-region");
    st.setRecordFormat("gif");
    st.startDrag({ x: 0, y: 0 });
    st.endDrag({ x: 5, y: 6, w: 30, h: 20 });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    await act(async () => {
      hook.current.finalize();
    });
    expect(startRecordingMock.mock.calls[0]?.[0].format).toBe("gif");
  });

  it("panoramic: finalize starts an auto-scroll recording in the chosen direction", async () => {
    const st = useOverlayStore.getState();
    st.setMode("panoramic");
    st.setScrollDirection("right");
    st.startDrag({ x: 0, y: 0 });
    st.endDrag({ x: 5, y: 6, w: 30, h: 20 });

    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(true);
    await act(async () => {
      hook.current.finalize();
    });
    expect(startPanoramicCaptureMock).toHaveBeenCalledWith(
      { x: 10, y: 12, width: 60, height: 40 },
      "right",
      false,
      true
    );
    expect(startScrollCaptureMock).not.toHaveBeenCalled();
  });

  it("color-pick: not finalizable here (no-op, click-driven)", () => {
    useOverlayStore.getState().setMode("color-pick");
    const { result: hook } = renderHook(() => useOverlayFinalize());
    expect(hook.current.ready).toBe(false);
    hook.current.finalize();
    expect(finishRegionCaptureMock).not.toHaveBeenCalled();
    expect(finishFreehandCaptureMock).not.toHaveBeenCalled();
    expect(finishMultiAreaCaptureMock).not.toHaveBeenCalled();
  });
});
