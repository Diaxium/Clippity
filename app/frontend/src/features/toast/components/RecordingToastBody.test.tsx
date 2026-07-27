import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the auto-stop handler the body registers so the test can drive
// a `recording/auto-stop` emit; tick/preview are stubbed (not asserted).
let autoStopHandler: (() => void) | null = null;
let previewHandler: ((e: { dataUri: string }) => void) | null = null;
const stopScrollCaptureMock = vi.fn();
const emitErrorToastMock = vi.fn();
const tickUnsub = vi.fn();
const previewUnsub = vi.fn();
const autoStopUnsub = vi.fn();

vi.mock("@services/tauri/clients/scroll", () => ({
  onRecordingTick: () => tickUnsub,
  onRecordingPreview: (cb: (e: { dataUri: string }) => void) => {
    previewHandler = cb;
    return previewUnsub;
  },
  onRecordingAutoStop: (cb: () => void) => {
    autoStopHandler = cb;
    return autoStopUnsub;
  },
  stopScrollCapture: (...args: unknown[]) => stopScrollCaptureMock(...args),
}));

vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...args: unknown[]) => emitErrorToastMock(...args),
}));

import { RecordingToastBody } from "./RecordingToastBody";

describe("RecordingToastBody", () => {
  beforeEach(() => {
    autoStopHandler = null;
    previewHandler = null;
    stopScrollCaptureMock.mockReset().mockResolvedValue(null);
    emitErrorToastMock.mockReset();
    tickUnsub.mockReset();
    previewUnsub.mockReset();
    autoStopUnsub.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits (discard=false) when Stop & Stitch is clicked", () => {
    render(<RecordingToastBody mode="scrolling" frames={3} />);
    fireEvent.click(screen.getByRole("button", { name: /stop & stitch/i }));
    expect(stopScrollCaptureMock).toHaveBeenCalledTimes(1);
    expect(stopScrollCaptureMock).toHaveBeenCalledWith(false);
  });

  it("discards (discard=true) when Discard is clicked", () => {
    render(<RecordingToastBody mode="scrolling" frames={3} />);
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(stopScrollCaptureMock).toHaveBeenCalledTimes(1);
    expect(stopScrollCaptureMock).toHaveBeenCalledWith(true);
  });

  it("auto-commits when the worker reports a scroll reversal", () => {
    render(<RecordingToastBody mode="scrolling" frames={5} />);
    expect(autoStopHandler).toBeInstanceOf(Function);
    act(() => autoStopHandler!());
    expect(stopScrollCaptureMock).toHaveBeenCalledTimes(1);
    expect(stopScrollCaptureMock).toHaveBeenCalledWith(false);
  });

  it("stops only once when manual clicks race the auto-stop event", () => {
    render(<RecordingToastBody mode="scrolling" frames={5} />);
    act(() => autoStopHandler!());
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    fireEvent.click(screen.getByRole("button", { name: /stop & stitch/i }));
    expect(stopScrollCaptureMock).toHaveBeenCalledTimes(1);
    expect(stopScrollCaptureMock).toHaveBeenCalledWith(false);
  });

  it("unsubscribes from every recording event on unmount", () => {
    const { unmount } = render(
      <RecordingToastBody mode="scrolling" frames={1} />
    );
    unmount();
    expect(tickUnsub).toHaveBeenCalledTimes(1);
    expect(previewUnsub).toHaveBeenCalledTimes(1);
    expect(autoStopUnsub).toHaveBeenCalledTimes(1);
  });

  it("reserves the preview box and swaps the placeholder for the frame", () => {
    render(<RecordingToastBody mode="scrolling" frames={0} />);
    // Before any frame a placeholder holds the fixed-height preview box,
    // so the window — and the controls below — never shift later.
    expect(screen.getByText("Scroll to capture")).toBeInTheDocument();
    expect(screen.queryByAltText("Live stitch preview")).toBeNull();

    act(() => previewHandler!({ dataUri: "data:image/png;base64,AAAA" }));

    expect(screen.queryByText("Scroll to capture")).toBeNull();
    expect(screen.getByAltText("Live stitch preview")).toHaveAttribute(
      "src",
      "data:image/png;base64,AAAA"
    );
  });

  it("panoramic mode tells the user it auto-scrolls, not to scroll", () => {
    const { container } = render(
      <RecordingToastBody mode="panoramic" frames={4} />
    );
    // The placeholder (a standalone node) must NOT instruct scrolling —
    // the app drives it. (Scrolling mode says "Scroll to capture".)
    expect(screen.getByText("Auto-scrolling…")).toBeInTheDocument();
    expect(screen.queryByText("Scroll to capture")).toBeNull();
    // The controls phrase swaps "scroll the content" for "auto-scrolling",
    // and the chip still names Panoramic (text split across nodes, so
    // assert against the normalized container text content).
    expect(container).toHaveTextContent("auto-scrolling");
    expect(container).not.toHaveTextContent("scroll the content");
    expect(container).toHaveTextContent("Recording · Panoramic");
  });

  it("renders the preview and the controls as two separate cards", () => {
    const { container } = render(
      <RecordingToastBody mode="scrolling" frames={2} />
    );
    const cards = container.querySelectorAll(".float-card");
    expect(cards).toHaveLength(2);
    // The controls (frame count + buttons) live in the second card, not
    // alongside the preview — so the live preview can't shove them around.
    const controls = cards[1];
    if (!(controls instanceof HTMLElement)) {
      throw new Error("expected a second .float-card for the controls");
    }
    expect(controls).toHaveTextContent("2 frames");
    expect(controls.querySelector("button")).not.toBeNull();
  });
});
