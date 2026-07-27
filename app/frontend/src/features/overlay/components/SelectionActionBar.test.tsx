import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const finishRegionCaptureMock = vi.fn();
const finishGrabTextMock = vi.fn();
const shareCaptureMock = vi.fn();
const emitErrorToastMock = vi.fn();

vi.mock("@services/tauri/clients/overlay", () => ({
  finishRegionCapture: (...a: unknown[]) => finishRegionCaptureMock(...a),
  finishGrabText: (...a: unknown[]) => finishGrabTextMock(...a),
}));
vi.mock("@services/tauri/clients/share", () => ({
  shareCapture: (...a: unknown[]) => shareCaptureMock(...a),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...a: unknown[]) => emitErrorToastMock(...a),
}));

import { useOverlayStore } from "../state/overlayStore";
import { SelectionActionBar } from "./SelectionActionBar";

/** A committed 60×80 selection at (20, 40) — the state the bar renders in. */
function selectRect() {
  act(() => {
    useOverlayStore.setState({
      mode: "region",
      phase: "selected",
      rect: { x: 20, y: 40, w: 60, h: 80 },
      cursorPin: null,
    });
  });
}

beforeEach(() => {
  finishRegionCaptureMock.mockReset().mockResolvedValue({
    id: "cap_1",
    width: 60,
    height: 80,
    path: "C:\\shots\\Region.png",
    preview: false,
  });
  finishGrabTextMock.mockReset().mockResolvedValue("hello");
  shareCaptureMock.mockReset().mockResolvedValue(undefined);
  emitErrorToastMock.mockReset();
  // devicePixelRatio 1 keeps the wire rect equal to the logical rect.
  window.devicePixelRatio = 1;
});

afterEach(() => {
  cleanup();
  act(() => {
    useOverlayStore.getState().reset();
  });
});

describe("SelectionActionBar — Save", () => {
  it("saves the file without touching the clipboard or the editor", async () => {
    // The regression this guards: Save rendered enabled but fell into the
    // placeholder branch and only raised a "coming soon" toast.
    selectRect();
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByLabelText("Save image"));

    await waitFor(() =>
      expect(finishRegionCaptureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rect: { x: 20, y: 40, width: 60, height: 80 },
          toggles: expect.objectContaining({
            clipboard: false,
            preview: false,
          }),
        })
      )
    );
    expect(emitErrorToastMock).not.toHaveBeenCalled();
  });

  it("carries the toolbar's enhance + cursor toggles through", async () => {
    // Overrides are per-action and narrow: everything the user set in the
    // BottomToolbar must survive them.
    act(() => {
      useOverlayStore.getState().setToggles({ enhance: true, cursor: true });
    });
    selectRect();
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByLabelText("Save image"));

    await waitFor(() =>
      expect(finishRegionCaptureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          toggles: expect.objectContaining({ enhance: true, cursor: true }),
        })
      )
    );
  });
});

describe("SelectionActionBar — OCR", () => {
  it("reads the region instead of saving an image", async () => {
    selectRect();
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByLabelText("Extract text (OCR)"));

    await waitFor(() => expect(finishGrabTextMock).toHaveBeenCalled());
    expect(finishGrabTextMock).toHaveBeenCalledWith({
      x: 20,
      y: 40,
      width: 60,
      height: 80,
    });
    // OCR produces a text entry, never a PNG.
    expect(finishRegionCaptureMock).not.toHaveBeenCalled();
  });

  it("toasts when the region has no readable text", async () => {
    finishGrabTextMock.mockRejectedValueOnce(new Error("no text found"));
    selectRect();
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByLabelText("Extract text (OCR)"));

    await waitFor(() =>
      expect(emitErrorToastMock).toHaveBeenCalledWith("no text found")
    );
  });

  it("scales the region by devicePixelRatio at the IPC seam", async () => {
    window.devicePixelRatio = 2;
    selectRect();
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByLabelText("Extract text (OCR)"));

    await waitFor(() =>
      expect(finishGrabTextMock).toHaveBeenCalledWith({
        x: 40,
        y: 80,
        width: 120,
        height: 160,
      })
    );
  });
});

describe("SelectionActionBar — Share", () => {
  it("opens a target menu rather than capturing straight away", () => {
    selectRect();
    render(<SelectionActionBar />);
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByLabelText("Share"));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(finishRegionCaptureMock).not.toHaveBeenCalled();
  });

  it("saves first, then hands the saved path to the chosen target", async () => {
    selectRect();
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByLabelText("Share"));
    fireEvent.click(screen.getByText("Show in folder"));

    await waitFor(() => expect(shareCaptureMock).toHaveBeenCalled());
    // The path comes from the capture result — sharing can't precede the
    // file existing.
    expect(shareCaptureMock).toHaveBeenCalledWith(
      "C:\\shots\\Region.png",
      "reveal"
    );
  });

  it("never opens the editor — the user asked to send it, not edit it", async () => {
    act(() => {
      useOverlayStore.getState().setToggles({ preview: true });
    });
    selectRect();
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByLabelText("Share"));
    fireEvent.click(screen.getByText("Copy file path"));

    await waitFor(() =>
      expect(finishRegionCaptureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          toggles: expect.objectContaining({ preview: false }),
        })
      )
    );
    await waitFor(() => expect(shareCaptureMock).toHaveBeenCalled());
    expect(shareCaptureMock).toHaveBeenCalledWith(
      "C:\\shots\\Region.png",
      "copy-path"
    );
  });

  it("toasts when the hand-off fails", async () => {
    shareCaptureMock.mockRejectedValueOnce(new Error("not a file"));
    selectRect();
    render(<SelectionActionBar />);
    fireEvent.click(screen.getByLabelText("Share"));
    fireEvent.click(screen.getByText("Open in default app"));

    await waitFor(() =>
      expect(emitErrorToastMock).toHaveBeenCalledWith("not a file")
    );
  });
});
