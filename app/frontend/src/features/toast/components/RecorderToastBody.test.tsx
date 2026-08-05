import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  RecorderLevels,
  RecorderStatus,
} from "@services/tauri/clients/recorder";

// Handlers the body registers, so the test can drive `recorder/*` emits.
let tickHandler: ((e: RecorderStatus) => void) | null = null;
let levelsHandler: ((e: RecorderLevels) => void) | null = null;
let finishedHandler: (() => void) | null = null;
const stopRecordingMock = vi.fn();
const pauseRecordingMock = vi.fn();
const resumeRecordingMock = vi.fn();
const recordingStatusMock = vi.fn();
const setRecordingGainMock = vi.fn();
const setRecordingMuteMock = vi.fn();
const emitErrorToastMock = vi.fn();
const tickUnsub = vi.fn();
const levelsUnsub = vi.fn();
const finishedUnsub = vi.fn();

vi.mock("@services/tauri/clients/recorder", () => ({
  onRecorderTick: (cb: (e: RecorderStatus) => void) => {
    tickHandler = cb;
    return tickUnsub;
  },
  onRecorderLevels: (cb: (e: RecorderLevels) => void) => {
    levelsHandler = cb;
    return levelsUnsub;
  },
  onRecorderFinished: (cb: () => void) => {
    finishedHandler = cb;
    return finishedUnsub;
  },
  stopRecording: (...args: unknown[]) => stopRecordingMock(...args),
  pauseRecording: (...args: unknown[]) => pauseRecordingMock(...args),
  resumeRecording: (...args: unknown[]) => resumeRecordingMock(...args),
  recordingStatus: (...args: unknown[]) => recordingStatusMock(...args),
  setRecordingGain: (...args: unknown[]) => setRecordingGainMock(...args),
  setRecordingMute: (...args: unknown[]) => setRecordingMuteMock(...args),
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
    levelsHandler = null;
    finishedHandler = null;
    setRecordingGainMock.mockReset().mockResolvedValue(undefined);
    setRecordingMuteMock.mockReset().mockResolvedValue(undefined);
    levelsUnsub.mockReset();
    stopRecordingMock.mockReset().mockResolvedValue(null);
    pauseRecordingMock
      .mockReset()
      .mockResolvedValue(status({ state: "paused" }));
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
    render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(stopRecordingMock).toHaveBeenCalledWith(false);
  });

  it("discards (discard=true) when Discard is clicked", () => {
    render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(stopRecordingMock).toHaveBeenCalledWith(true);
  });

  it("reaps the session when it ends on its own", () => {
    // A session can end without anyone pressing Stop — a duration
    // ceiling, or a failed encoder. If the HUD ignored the event it
    // would sit on screen forever over a session that already finished.
    render(
      <RecorderToastBody format="gif" microphone={false} system={false} />
    );
    act(() => finishedHandler?.());
    expect(stopRecordingMock).toHaveBeenCalledWith(false);
  });

  it("reaps only once when Stop races the finished event", () => {
    render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    act(() => finishedHandler?.());
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(stopRecordingMock).toHaveBeenCalledTimes(1);
  });

  it("renders the elapsed clock from ticks", () => {
    render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
    act(() => tickHandler?.(status({ elapsedMs: 65_000 })));
    expect(screen.getByText("01:05")).toBeInTheDocument();
  });

  it("swaps Pause for Resume while paused", async () => {
    render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
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
    render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
    expect(await screen.findByText("00:09")).toBeInTheDocument();
  });

  it("surfaces a failed stop as an error toast", async () => {
    stopRecordingMock.mockRejectedValue(new Error("disk full"));
    render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    await vi.waitFor(() =>
      expect(emitErrorToastMock).toHaveBeenCalledWith("disk full")
    );
  });

  it("unsubscribes every listener on unmount", () => {
    const { unmount } = render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
    unmount();
    expect(tickUnsub).toHaveBeenCalled();
    expect(levelsUnsub).toHaveBeenCalled();
    expect(finishedUnsub).toHaveBeenCalled();
  });

  // ---------- audio mixer ----------

  it("shows a mixer row only for the inputs the session opened", () => {
    const { rerender } = render(
      <RecorderToastBody format="mp4" microphone={false} system={false} />
    );
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();

    rerender(<RecorderToastBody format="mp4" microphone system={false} />);
    expect(screen.getByLabelText(/microphone level/i)).toBeInTheDocument();
    expect(
      screen.queryByLabelText(/system audio level/i)
    ).not.toBeInTheDocument();

    rerender(<RecorderToastBody format="mp4" microphone system />);
    expect(screen.getAllByRole("meter")).toHaveLength(2);
  });

  it("moves the meter with the levels event", () => {
    render(<RecorderToastBody format="mp4" microphone system={false} />);
    act(() => levelsHandler?.({ microphone: 0.42, system: 0 }));
    expect(screen.getByLabelText(/microphone level/i)).toHaveAttribute(
      "aria-valuenow",
      "42"
    );
  });

  it("drops the meters to zero while paused", () => {
    // A paused session hears nothing; a bar frozen mid-height would
    // claim otherwise.
    render(<RecorderToastBody format="mp4" microphone system={false} />);
    act(() => levelsHandler?.({ microphone: 0.8, system: 0 }));
    act(() => tickHandler?.(status({ state: "paused" })));
    expect(screen.getByLabelText(/microphone level/i)).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
  });

  it("mutes and unmutes one input without touching the other", () => {
    render(<RecorderToastBody format="mp4" microphone system />);
    fireEvent.click(screen.getByRole("button", { name: /mute microphone/i }));
    expect(setRecordingMuteMock).toHaveBeenCalledWith("microphone", true);

    fireEvent.click(screen.getByRole("button", { name: /unmute microphone/i }));
    expect(setRecordingMuteMock).toHaveBeenLastCalledWith("microphone", false);
    // The system row was never addressed.
    expect(setRecordingMuteMock).not.toHaveBeenCalledWith("system", true);
  });

  it("sends a gain change for the source whose slider moved", () => {
    render(<RecorderToastBody format="mp4" microphone system />);
    fireEvent.change(screen.getByLabelText(/system audio volume/i), {
      target: { value: "60" },
    });
    expect(setRecordingGainMock).toHaveBeenCalledWith("system", 60);
  });

  it("moving the slider un-mutes, so the control is never dead", () => {
    render(<RecorderToastBody format="mp4" microphone system={false} />);
    fireEvent.click(screen.getByRole("button", { name: /mute microphone/i }));
    fireEvent.change(screen.getByLabelText(/microphone volume/i), {
      target: { value: "80" },
    });
    expect(setRecordingGainMock).toHaveBeenCalledWith("microphone", 80);
    expect(
      screen.getByRole("button", { name: /mute microphone/i })
    ).toBeInTheDocument();
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
