import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecorderStatus } from "@services/tauri/clients/recorder";

// Handlers the body registers, so the test can drive `recorder/*` emits.
let tickHandler: ((e: RecorderStatus) => void) | null = null;
let finishedHandler: (() => void) | null = null;
const stopRecordingMock = vi.fn();
const pauseRecordingMock = vi.fn();
const resumeRecordingMock = vi.fn();
const recordingStatusMock = vi.fn();
const emitErrorToastMock = vi.fn();
const tickUnsub = vi.fn();
const finishedUnsub = vi.fn();

vi.mock("@services/tauri/clients/recorder", () => ({
  onRecorderTick: (cb: (e: RecorderStatus) => void) => {
    tickHandler = cb;
    return tickUnsub;
  },
  onRecorderFinished: (cb: () => void) => {
    finishedHandler = cb;
    return finishedUnsub;
  },
  stopRecording: (...args: unknown[]) => stopRecordingMock(...args),
  pauseRecording: (...args: unknown[]) => pauseRecordingMock(...args),
  resumeRecording: (...args: unknown[]) => resumeRecordingMock(...args),
  recordingStatus: (...args: unknown[]) => recordingStatusMock(...args),
}));

vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...args: unknown[]) => emitErrorToastMock(...args),
}));

import {
  formatBytes,
  formatDetail,
  formatElapsed,
  RecorderToastBody,
} from "./RecorderToastBody";

function status(patch: Partial<RecorderStatus> = {}): RecorderStatus {
  return {
    state: "recording",
    elapsedMs: 0,
    frames: 0,
    dropped: 0,
    bytes: 0,
    ...patch,
  };
}

describe("RecorderToastBody", () => {
  beforeEach(() => {
    tickHandler = null;
    finishedHandler = null;
    stopRecordingMock.mockReset().mockResolvedValue(null);
    pauseRecordingMock.mockReset().mockResolvedValue(status({ state: "paused" }));
    resumeRecordingMock.mockReset().mockResolvedValue(status());
    recordingStatusMock.mockReset().mockResolvedValue(status());
    emitErrorToastMock.mockReset();
    tickUnsub.mockReset();
    finishedUnsub.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits (discard=false) when Stop is clicked", () => {
    render(<RecorderToastBody format="mp4" audio={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(stopRecordingMock).toHaveBeenCalledWith(false);
  });

  it("discards (discard=true) when Discard is clicked", () => {
    render(<RecorderToastBody format="mp4" audio={false} />);
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(stopRecordingMock).toHaveBeenCalledWith(true);
  });

  it("reaps the session when it ends on its own", () => {
    // A session can end without anyone pressing Stop — a duration
    // ceiling, or a failed encoder. If the HUD ignored the event it
    // would sit on screen forever over a session that already finished.
    render(<RecorderToastBody format="gif" audio={false} />);
    act(() => finishedHandler?.());
    expect(stopRecordingMock).toHaveBeenCalledWith(false);
  });

  it("reaps only once when Stop races the finished event", () => {
    render(<RecorderToastBody format="mp4" audio={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    act(() => finishedHandler?.());
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(stopRecordingMock).toHaveBeenCalledTimes(1);
  });

  it("renders the elapsed clock from ticks", () => {
    render(<RecorderToastBody format="mp4" audio={false} />);
    act(() => tickHandler?.(status({ elapsedMs: 65_000 })));
    expect(screen.getByText("01:05")).toBeInTheDocument();
  });

  it("swaps Pause for Resume while paused", async () => {
    render(<RecorderToastBody format="mp4" audio={false} />);
    expect(
      screen.getByRole("button", { name: /pause recording/i })
    ).toBeInTheDocument();

    act(() => tickHandler?.(status({ state: "paused" })));
    expect(
      screen.getByRole("button", { name: /resume recording/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/paused/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /resume recording/i }));
    expect(resumeRecordingMock).toHaveBeenCalled();
    expect(pauseRecordingMock).not.toHaveBeenCalled();
  });

  it("asks for the current status on mount", async () => {
    // The toast window persists across sessions, so a remount mid-
    // recording must not show 00:00 until the next tick.
    recordingStatusMock.mockResolvedValue(status({ elapsedMs: 9_000 }));
    render(<RecorderToastBody format="mp4" audio={false} />);
    expect(await screen.findByText("00:09")).toBeInTheDocument();
  });

  it("surfaces a failed stop as an error toast", async () => {
    stopRecordingMock.mockRejectedValue(new Error("disk full"));
    render(<RecorderToastBody format="mp4" audio={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    await vi.waitFor(() =>
      expect(emitErrorToastMock).toHaveBeenCalledWith("disk full")
    );
  });

  it("unsubscribes both listeners on unmount", () => {
    const { unmount } = render(
      <RecorderToastBody format="mp4" audio={false} />
    );
    unmount();
    expect(tickUnsub).toHaveBeenCalled();
    expect(finishedUnsub).toHaveBeenCalled();
  });
});

describe("formatElapsed", () => {
  it("renders mm:ss below an hour", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(9_000)).toBe("00:09");
    expect(formatElapsed(65_000)).toBe("01:05");
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe("59:59");
  });

  it("adds an hours field once past an hour", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });

  it("never renders a negative clock", () => {
    expect(formatElapsed(-5_000)).toBe("00:00");
  });
});

describe("formatDetail", () => {
  it("says so before the first status arrives", () => {
    expect(formatDetail(null)).toBe("Starting…");
  });

  it("hides the dropped count while nothing is dropping", () => {
    // A permanent "0 dropped" trains users to ignore the number; it
    // appearing at all is the signal to lower the frame rate.
    expect(formatDetail(status({ bytes: 2_048 }))).toBe("2 KB");
  });

  it("shows the dropped count once frames are missed", () => {
    expect(formatDetail(status({ bytes: 2_048, dropped: 7 }))).toBe(
      "2 KB · 7 dropped"
    );
  });
});

describe("formatBytes", () => {
  it("scales through B, KB and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
